import assert from "node:assert/strict";
import { OrderBookAnalyzer } from "./strategy-engine/hft/OrderBookAnalyzer.mjs";

function approx(actual, expected, epsilon = 1e-9) {
  assert.equal(typeof actual, "number");
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

const analyzer = new OrderBookAnalyzer({ maxHistory: 3 });
assert.equal(analyzer.bestBid(), 0);
assert.equal(analyzer.bestAsk(), 0);
assert.equal(analyzer.midPrice(), 0);
assert.equal(analyzer.spread(), 0);
assert.equal(analyzer.spreadPct(), 0);
assert.equal(analyzer.weightedMidPrice(), 0);
assert.deepEqual(analyzer.marketImpact("buy", 0), { avgPrice: 0, slippage: 0, unfilled: 0 });

const entry = analyzer.update(
  {
    bids: [
      [99, 10],
      [98, 5],
      [97, 1],
    ],
    asks: [
      [101, 8],
      [102, 4],
      [103, 2],
    ],
  },
  1_000,
);

assert.deepEqual(entry, { time: 1_000, mid: 100, imbalance: 2 / 30 });
assert.equal(analyzer.bestBid(), 99);
assert.equal(analyzer.bestAsk(), 101);
assert.equal(analyzer.midPrice(), 100);
assert.equal(analyzer.spread(), 2);
approx(analyzer.spreadPct(), 0.02);
approx(analyzer.imbalance(2), 3 / 27);
approx(analyzer.weightedMidPrice(), (99 * 8 + 101 * 10) / 18);
assert.deepEqual(analyzer.marketImpact("buy", 10), {
  avgPrice: 101.2,
  slippage: 1.2000000000000028,
  unfilled: 0,
});
assert.deepEqual(analyzer.marketImpact("sell", 20), {
  avgPrice: 98.5625,
  slippage: 1.4375,
  unfilled: 4,
});
assert.deepEqual(analyzer.marketImpact("hold", 3), { avgPrice: 0, slippage: 0, unfilled: 3 });

const largeOrderAnalyzer = new OrderBookAnalyzer();
largeOrderAnalyzer.update(
  {
    bids: [
      [99, 100],
      [98, 1],
    ],
    asks: [
      [101, 1],
      [102, 1],
    ],
  },
  2_000,
);
assert.deepEqual(largeOrderAnalyzer.detectLargeOrders(2), [{ side: "bid", price: 99, qty: 100 }]);

analyzer.update({ bids: [[100, 10]], asks: [[102, 10]] }, 1_100);
analyzer.update({ bids: [[101, 5]], asks: [[103, 15]] }, 1_200);
analyzer.update({ bids: [[102, 15]], asks: [[104, 5]] }, 1_300);
assert.equal(analyzer.history.length, 3);
assert.equal(analyzer.midMomentum(3), 2);
assert.ok(analyzer.toxicity(3) > 0);

const sanitized = new OrderBookAnalyzer();
sanitized.update({
  bids: [
    ["bad", 1],
    [100, -1],
    [99, 2],
  ],
  asks: [
    [101, 2],
    [102, "bad"],
  ],
});
assert.deepEqual(sanitized.bids, [[99, 2]]);
assert.deepEqual(sanitized.asks, [[101, 2]]);
assert.equal(sanitized.midPrice(), 100);

process.stdout.write("capital strategy order book analyzer check PASS\n");
