import assert from "node:assert/strict";
import {
  ATR,
  BollingerBands,
  EMA,
  MACD,
  RSI,
  SMA,
  Stochastic,
  Supertrend,
} from "./strategy-engine/Indicators.mjs";

function approx(actual, expected, epsilon = 1e-9) {
  assert.equal(typeof actual, "number");
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

const prices = Array.from({ length: 40 }, (_, index) => index + 1);
const highs = prices.map((value) => value + 1);
const lows = prices.map((value) => value - 1);
const closes = [...prices];

assert.equal(SMA([1, 2, 3, 4, 5], 3), 4);
assert.equal(SMA([1, 2], 3), null);
approx(EMA([1, 2, 3, 4, 5], 3), 4);

const rsiUp = RSI(prices, 14);
assert.ok(rsiUp > 99.999);

const macd = MACD(prices);
assert.ok(macd);
assert.equal(Object.keys(macd).toSorted().join(","), "hist,macd,signal");
assert.ok(macd.macd > 0);

approx(ATR(highs, lows, closes, 14), 2);

const bands = BollingerBands(prices, 20, 2);
assert.ok(bands);
assert.equal(bands.middle, 30.5);
assert.ok(bands.upper > bands.middle);
assert.ok(bands.lower < bands.middle);

const supertrend = Supertrend(highs, lows, closes, 10, 3);
assert.ok(supertrend);
assert.equal(supertrend.direction, 1);

const stochastic = Stochastic(highs, lows, closes, 14, 3);
assert.ok(stochastic);
assert.ok(stochastic.k > 90);
assert.ok(stochastic.d > 90);

assert.equal(RSI([1, 2], 14), null);
assert.equal(MACD([1, 2, 3]), null);
assert.equal(BollingerBands([1, 2], 20), null);
assert.equal(Stochastic([1], [1], [1], 14, 3), null);

process.stdout.write("capital strategy indicators check PASS\n");
