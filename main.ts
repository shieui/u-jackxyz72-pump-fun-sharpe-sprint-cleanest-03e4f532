// Steady paper bot for the Pump.fun Sharpe Sprint.
//
// What the dev data showed: a fresh coin's first burst of buying lifts its
// price fast, and a bot that answers a batch can only fill two slots later —
// by then the burst is usually spent (the median fill lands ~15% above the
// price where the coin's real reserve first reached 1 SOL) and the coin
// dumps from there. Chasing the burst loses. So this bot waits instead: it
// notes the slot and price where a coin's real reserve first reaches 1 SOL,
// then only buys about a minute later, and only if the price is still at or
// above that crossing price — follow-through demand, not a spent spike.
// It then lets winners run under a wide trailing stop and a wide stop-loss,
// with a long maximum hold, so the rare coin that keeps climbing pays for
// the many small losers. One small fixed stake (0.01 SOL) per coin, at most
// five open at once, spread across many coins for the 20-mint guardrail.
//
// Deterministic: every decision comes from the hello/batch stream only.
// No clock, no randomness, no network, no files outside this repo.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** SOL spent per buy (0.01 SOL — the smallest round trip that counts). */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 100n;
/** Real reserve that first makes the 1%-of-reserve cap cover the stake. */
const MIN_REAL_SOL_LAMPORTS = LAMPORTS_PER_SOL;
/** Slots to wait after the crossing before buying (~40 seconds). */
const CONFIRM_DELAY_SLOTS = 200;
/** How long after the crossing the entry stays open (slots). */
const CONFIRM_WINDOW_SLOTS = 600;
/** Stop loss below the entry price (bps). */
const STOP_LOSS_BPS = 4000n;
/** Trailing stop: sell once the price falls this far below its peak since entry (bps). */
const TRAIL_BPS = 3000n;
/** Maximum hold, in slots (~70 minutes). */
const MAX_HOLD_SLOTS = 20000;
/** Slippage allowance on every order (bps). Wide enough to survive the 2-slot latency on a fast curve. */
const SLIPPAGE_BPS = 2000;

const BPS_DEN = 10_000n;

// ------------------------------------------------------------------ helpers

/** A price as a ratio quote/token, kept as bigints so comparisons are exact. */
interface Ratio {
  q: bigint;
  t: bigint;
}

/** price a >= price b ? */
function atLeast(a: Ratio, b: Ratio): boolean {
  return a.q * b.t >= b.q * a.t;
}

/** price a <= price b * (1 - bps/10000) ? */
function atMostBelow(a: Ratio, b: Ratio, bps: bigint): boolean {
  return a.q * b.t * BPS_DEN <= b.q * a.t * (BPS_DEN - bps);
}

interface Tracked {
  mint: string;
  /** Slot and price where the coin's real reserve first reached the threshold; null until then. */
  crossSlot: number | null;
  crossPrice: Ratio | null;
  bought: boolean;
  /** Price at the batch the buy was decided on. */
  entryPrice: Ratio | null;
  /** Highest price seen since the buy. */
  peakPrice: Ratio | null;
  buySlot: number;
  /** Slot of the latest event seen on this coin. */
  lastSeenSlot: number;
  /** True once this mint has been seen held in the account (its buy fill landed). */
  seenHeld: boolean;
}

// ------------------------------------------------------------------ state

const tracked = new Map<string, Tracked>();
/** Mints ever bought in this run: a coin is entered at most once, however often it re-crosses. */
const enteredMints = new Set<string>();

function priceOf(state: BotState, mint: string): Ratio | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  if (c.virtual_token_reserves <= 0n || c.virtual_quote_reserves <= 0n) return null;
  return { q: c.virtual_quote_reserves, t: c.virtual_token_reserves };
}

function track(mint: string, slot: number): Tracked {
  let tr = tracked.get(mint);
  if (tr === undefined) {
    tr = { mint, crossSlot: null, crossPrice: null, bought: false, entryPrice: null, peakPrice: null, buySlot: 0, lastSeenSlot: slot, seenHeld: false };
    tracked.set(mint, tr);
  }
  tr.lastSeenSlot = slot;
  return tr;
}

// ------------------------------------------------------------------ bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // Mark records of coins currently held: their buy fill has landed.
    for (const mint of state.positions.keys()) {
      const tr = tracked.get(mint);
      if (tr !== undefined) tr.seenHeld = true;
    }

    // Fold this batch's events into the per-coin records.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        track(e.mint, e.slot);
      } else if (e.event === 'TradeEvent') {
        const tr = track(e.mint, e.slot);
        const curve = state.curves.get(e.mint);
        if (tr.crossSlot === null && curve !== undefined && curve.real_quote_reserves >= MIN_REAL_SOL_LAMPORTS) {
          const price = priceOf(state, e.mint);
          if (price !== null) {
            tr.crossSlot = e.slot;
            tr.crossPrice = price;
          }
        }
      } else if (e.event === 'CompleteEvent') {
        // Curve is marked complete in state.curves; the record stays so a
        // held position keeps its entry data until the harness closes it.
      }
    }

    // Exits first: free slots and cash for new entries. A sell already in
    // flight covers the position, so never send a second one for it.
    const sellPending = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') sellPending.add(p.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (sellPending.has(mint)) continue;
      const tr = tracked.get(mint);
      const price = priceOf(state, mint);
      if (price === null) continue;
      if (tr !== undefined && tr.entryPrice !== null) {
        if (tr.peakPrice === null || atLeast(price, tr.peakPrice)) tr.peakPrice = price;
      }
      let exit = false;
      if (tr !== undefined && tr.entryPrice !== null && tr.peakPrice !== null) {
        if (atMostBelow(price, tr.entryPrice, STOP_LOSS_BPS)) exit = true; // stop loss
        else if (atMostBelow(price, tr.peakPrice, TRAIL_BPS)) exit = true; // trailing stop
        else if (state.slot - tr.buySlot > MAX_HOLD_SLOTS) exit = true; // time stop
      } else if (tr === undefined) {
        // A position with no record (should not happen): exit on sight.
        exit = true;
      }
      if (exit && orders.length < caps.max_orders_per_batch) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
      }
    }

    // Entries: coins whose crossing was a while ago and whose price held up.
    if (slots > 0) {
      for (const [mint, tr] of tracked) {
        if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
        if (tr.bought || enteredMints.has(mint) || tr.crossSlot === null || tr.crossPrice === null) continue;
        const age = state.slot - tr.crossSlot;
        if (age < CONFIRM_DELAY_SLOTS) continue;
        if (age > CONFIRM_DELAY_SLOTS + CONFIRM_WINDOW_SLOTS) {
          tracked.delete(mint); // confirmation window closed without an entry
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = priceOf(state, mint);
        if (price === null) continue;
        if (!atLeast(price, tr.crossPrice)) continue; // demand did not hold up
        if (state.maxBuyLamports(mint) < STAKE_LAMPORTS) continue;
        if (free < STAKE_LAMPORTS + tx) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: STAKE_LAMPORTS,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        tr.bought = true;
        enteredMints.add(mint);
        tr.entryPrice = price;
        tr.peakPrice = price;
        tr.buySlot = state.slot;
        free -= STAKE_LAMPORTS + tx;
        slots -= 1;
      }
    }

    // Drop records of positions that were held and have now closed (their buy
    // fill landed first: seenHeld), and of coins that never crossed and have
    // gone quiet. A bought record is never dropped while its fill is still in
    // flight, or its entry price would be lost and the position could never exit.
    for (const [mint, tr] of tracked) {
      if (tr.bought && tr.seenHeld && !state.positions.has(mint)) tracked.delete(mint);
      else if (tr.crossSlot === null && state.slot - tr.lastSeenSlot > MAX_HOLD_SLOTS) tracked.delete(mint);
    }
    return orders;
  },
});
