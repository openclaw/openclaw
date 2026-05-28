import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PairsTradingStrategy } from "./strategy-engine/arbitrage/PairsTradingStrategy.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const localPairsPath = path.join(
  repoRoot,
  "scripts",
  "strategy-engine",
  "arbitrage",
  "PairsTradingStrategy.mjs",
);

function pushPair(strategy, priceA, priceB) {
  const signalA = strategy.onBarA({ close: priceA });
  const signalB = strategy.onBarB({ close: priceB });
  return signalA ?? signalB;
}

const strategy = new PairsTradingStrategy({
  name: "pairs-check",
  auto: true,
  allowAutoExecute: false,
  now: () => new Date("2026-05-20T00:00:00.000Z"),
  params: {
    lookback: 5,
    minBars: 6,
    entryZ: 1.5,
    exitZ: 0.5,
    stopZ: 3.0,
    useLog: false,
    enforceHalfLife: false,
    minHalfLife: 0,
    maxHalfLife: 999,
  },
  legA: { instrument: "A", broker: "paper", maxQty: 1 },
  legB: { instrument: "B", broker: "paper", maxQty: 1 },
});

for (const priceA of [100, 100, 100, 100, 100, 100, 100, 100, 100]) {
  pushPair(strategy, priceA, 100);
}

let signal = pushPair(strategy, 110, 100);
assert.ok(signal, "must emit open signal on positive spread deviation");
assert.equal(signal.direction, "open_spread");
assert.equal(signal.autoExecute, false);
assert.equal(signal.legA.direction, "sell");
assert.equal(signal.legB.direction, "buy");
assert.equal(strategy.position, 1);
assert.equal(strategy.popSignals().length, 1);

signal = null;
for (let i = 0; i < 6; i += 1) {
  signal = pushPair(strategy, 100, 100);
  if (signal) {
    break;
  }
}
assert.ok(signal, "must emit close signal when spread normalizes");
assert.equal(signal.direction, "close_spread");
assert.equal(signal.legA.direction, "buy");
assert.equal(signal.legB.direction, "sell");
assert.equal(strategy.position, 0);

const signalAfterClose = strategy.popSignals();
assert.equal(signalAfterClose.length, 1);

assert.equal(
  Object.prototype.hasOwnProperty.call(PairsTradingStrategy.prototype, "evaluate"),
  true,
);
assert.equal(
  Object.prototype.hasOwnProperty.call(PairsTradingStrategy.prototype, "_evaluate"),
  false,
);

const report = {
  schema: "openclaw.capital.strategy.pairs-trading-check.v1",
  generatedAt: new Date().toISOString(),
  status: "passed",
  blockerCode: "",
  reason:
    "PairsTradingStrategy is local OpenClaw-safe evaluator and emits spread signals via evaluate().",
  safetyLock: {
    allowLiveTrading: false,
    writeBrokerOrders: false,
  },
  source: {
    file: localPairsPath,
    hasEvaluateOverride: true,
    hasPrivateEvaluate: false,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
