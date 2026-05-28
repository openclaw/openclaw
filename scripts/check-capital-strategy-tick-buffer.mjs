import assert from "node:assert/strict";
import { TickBuffer } from "./strategy-engine/hft/TickBuffer.mjs";

function approx(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

const buffer = new TickBuffer(3);
assert.equal(buffer.size, 0);
assert.equal(buffer.latest(), null);
assert.equal(buffer.vwap(), 0);
assert.deepEqual(buffer.volumeRatio(), { buy: 0, sell: 0, ratio: 0.5 });

buffer.push({ time: 1_000, price: 100, qty: 2, side: "B", ask: 101, bid: 99 });
buffer.push({ time: 1_100, price: 102, qty: 1, side: "S", ask: 103, bid: 101 });
buffer.push({ time: 1_200, price: 101, qty: 3, side: "", ask: 102, bid: 100 });

assert.equal(buffer.size, 3);
assert.equal(buffer.latest().price, 101);
assert.deepEqual(
  buffer.last(2).map((tick) => tick.price),
  [101, 102],
);
approx(buffer.vwap(), (100 * 2 + 102 * 1 + 101 * 3) / 6);
assert.deepEqual(buffer.volumeRatio(), { buy: 2, sell: 1, ratio: 2 / 3 });
assert.equal(buffer.upticks(3), 1);
assert.equal(buffer.downticks(3), 1);
approx(buffer.stdDev(2), 0.5);
assert.equal(buffer.arrivalRate(250, 1_300), 2);

buffer.push({ time: 1_300, price: 104, qty: 4, side: "B", ask: 105, bid: 103 });

assert.equal(buffer.size, 3);
assert.deepEqual(
  buffer.last(3).map((tick) => tick.price),
  [104, 101, 102],
);
approx(buffer.vwap(), (102 * 1 + 101 * 3 + 104 * 4) / 8);
assert.deepEqual(buffer.volumeRatio(), { buy: 4, sell: 1, ratio: 4 / 5 });

const fallback = new TickBuffer(0);
assert.equal(fallback.capacity, 2000);
fallback.push({ price: "bad", qty: -1, side: "X" });
assert.equal(fallback.latest().price, 0);
assert.equal(fallback.latest().qty, 0);
assert.equal(fallback.latest().side, "");

process.stdout.write("capital strategy tick buffer check PASS\n");
