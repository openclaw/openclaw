import assert from "node:assert/strict";
import {
  FundingRateArbitrage,
  normalizeFundingRates,
} from "./strategy-engine/arbitrage/FundingRateArbitrage.mjs";

let now = new Date("2026-05-20T00:00:00.000Z");
const strategy = new FundingRateArbitrage({
  name: "funding-check",
  auto: true,
  allowAutoExecute: false,
  now: () => now,
  params: {
    minAnnualizedRate: 0.3,
    exitAnnualizedRate: 0.05,
    notionalUsd: 2000,
    maxPositions: 1,
  },
});

let signals = strategy.scan([
  { symbol: "BTC-USDT-SWAP", fundingRate: 0.0004 },
  { symbol: "ETH-USDT-SWAP", fundingRate: 0.0001 },
]);

assert.equal(signals.length, 1);
assert.equal(signals[0].direction, "open");
assert.equal(signals[0].side, "long_spot_short_perp");
assert.equal(signals[0].autoExecute, false);
assert.equal(signals[0].spotLeg.direction, "buy");
assert.equal(signals[0].perpLeg.direction, "sell");
assert.equal(signals[0].notionalUsd, 2000);
assert.equal(Object.keys(strategy.getPositions()).length, 1);
assert.equal(strategy.popSignals().length, 1);

signals = strategy.scan([{ symbol: "BTC-USDT-SWAP", fundingRate: 0.00045 }]);
assert.equal(signals.length, 0);

now = new Date("2026-05-20T08:00:00.000Z");
signals = strategy.scan([{ symbol: "BTC-USDT-SWAP", fundingRate: 0.00001 }]);
assert.equal(signals.length, 1);
assert.equal(signals[0].direction, "close");
assert.equal(Object.keys(strategy.getPositions()).length, 0);

now = new Date("2026-05-20T16:00:00.000Z");
signals = strategy.scan([{ symbol: "ETH-USDT-SWAP", fundingRate: -0.0004 }]);
assert.equal(signals.length, 1);
assert.equal(signals[0].side, "short_spot_long_perp");
assert.equal(signals[0].spotLeg.direction, "sell");
assert.equal(signals[0].perpLeg.direction, "buy");

assert.deepEqual(
  normalizeFundingRates([
    { symbol: "", fundingRate: 1 },
    { symbol: "BAD", fundingRate: "x" },
  ]),
  [],
);

process.stdout.write("capital strategy funding rate arbitrage check PASS\n");
