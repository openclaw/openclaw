import assert from "node:assert/strict";
import { FuturesCashArbitrageStrategy } from "./strategy-engine/arbitrage/FuturesCashArbitrageStrategy.mjs";

function pushPair(strategy, future, spot) {
  const firstSignal = strategy.onBarA({ close: future });
  const secondSignal = strategy.onBarB({ close: spot });
  return firstSignal ?? secondSignal;
}

const richStrategy = new FuturesCashArbitrageStrategy({
  name: "futures-cash-check",
  auto: true,
  allowAutoExecute: false,
  params: {
    lookback: 5,
    entryZ: 1.5,
    exitZ: 0.5,
    fundingRate: 0,
    minBars: 6,
  },
  legA: { instrument: "TXF", broker: "capital", maxQty: 2 },
  legB: { instrument: "TSE", broker: "cash", maxQty: 2 },
  now: () => new Date("2026-05-20T00:00:00.000Z"),
});

for (const future of [100, 100, 100, 100, 100]) {
  pushPair(richStrategy, future, 100);
}
let signal = pushPair(richStrategy, 110, 100);

assert.equal(signal.direction, "open_spread");
assert.equal(signal.autoExecute, false);
assert.equal(signal.legA.direction, "sell");
assert.equal(signal.legB.direction, "buy");
assert.equal(richStrategy.position, 1);
assert.equal(richStrategy.popSignals().length, 1);

signal = pushPair(richStrategy, 100, 100);
assert.equal(signal.direction, "close_spread");
assert.equal(signal.legA.direction, "buy");
assert.equal(signal.legB.direction, "sell");
assert.equal(richStrategy.position, 0);

const cheapStrategy = new FuturesCashArbitrageStrategy({
  name: "futures-cash-cheap-check",
  params: {
    lookback: 5,
    entryZ: 1.5,
    fundingRate: 0,
    minBars: 6,
  },
  legA: { instrument: "BTC-PERP", broker: "perp", maxQty: 1 },
  legB: { instrument: "BTC", broker: "spot", maxQty: 1 },
});

for (const future of [100, 100, 100, 100, 100]) {
  pushPair(cheapStrategy, future, 100);
}
signal = pushPair(cheapStrategy, 90, 100);

assert.equal(signal.direction, "open_spread");
assert.equal(signal.legA.direction, "buy");
assert.equal(signal.legB.direction, "sell");
assert.equal(cheapStrategy.position, -1);

assert.equal(
  Number(
    new FuturesCashArbitrageStrategy({ params: { daysToExpiry: 30, riskFree: 0.05 } })
      .theoreticalBasis(100)
      .toFixed(4),
  ) > 0,
  true,
);

process.stdout.write("capital strategy futures cash arbitrage check PASS\n");
