import assert from "node:assert/strict";
import { CrossExchangeArbitrageStrategy } from "./strategy-engine/arbitrage/CrossExchangeArbitrageStrategy.mjs";

let now = new Date("2026-05-20T00:00:00.000Z");
const strategy = new CrossExchangeArbitrageStrategy({
  name: "cross-check",
  auto: true,
  allowAutoExecute: false,
  now: () => now,
  exchangeA: { id: "okx" },
  exchangeB: { id: "binance" },
  params: {
    symbol: "BTC-USDT",
    qty: 0.5,
    feePct: 0.001,
    minSpreadPct: 0.003,
    cooldownSec: 30,
  },
});

let signal = strategy.scan({
  exchangeA: { bid: 99, ask: 100 },
  exchangeB: { bid: 101, ask: 102 },
});

assert.equal(signal.direction, "open_spread");
assert.equal(signal.autoExecute, false);
assert.equal(signal.legA.broker, "okx");
assert.equal(signal.legA.direction, "buy");
assert.equal(signal.legA.price, 100);
assert.equal(signal.legB.broker, "binance");
assert.equal(signal.legB.direction, "sell");
assert.equal(signal.legB.price, 101);
assert.equal(signal.legA.qty, 0.5);
assert.equal(strategy.popSignals().length, 1);

signal = strategy.scan({
  exchangeA: { bid: 99, ask: 100 },
  exchangeB: { bid: 101, ask: 102 },
});
assert.equal(signal, null);
assert.equal(strategy.popSignals().length, 0);

now = new Date("2026-05-20T00:00:31.000Z");
signal = strategy.scan({
  exchangeA: { bid: 105, ask: 106 },
  exchangeB: { bid: 100, ask: 101 },
});

assert.equal(signal.direction, "open_spread");
assert.equal(signal.legA.direction, "sell");
assert.equal(signal.legB.direction, "buy");
assert.equal(signal.legA.price, 105);
assert.equal(signal.legB.price, 101);
assert.equal(strategy.popSignals().length, 1);

assert.equal(strategy.scan({ exchangeA: { bid: 0, ask: 0 }, exchangeB: { bid: 1, ask: 1 } }), null);

process.stdout.write("capital strategy cross exchange arbitrage check PASS\n");
