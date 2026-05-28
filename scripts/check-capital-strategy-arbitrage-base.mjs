import assert from "node:assert/strict";
import { ArbitrageBase } from "./strategy-engine/arbitrage/ArbitrageBase.mjs";

const fixedNow = () => new Date("2026-05-20T00:00:00.000Z");
const strategy = new ArbitrageBase({
  name: "pairs-check",
  auto: true,
  allowAutoExecute: false,
  now: fixedNow,
  maxBars: 3,
  legA: { instrument: "TX", broker: "paper", maxQty: 2 },
  legB: { instrument: "MTX", broker: "paper", maxQty: 1 },
});

strategy.onBarA({ close: 100 });
strategy.onBarA({ close: 101 });
strategy.onBarA({ close: 102 });
strategy.onBarA({ close: 103 });
strategy.onBarB({ close: 50 });
strategy.onBarB({ close: 51 });

assert.equal(strategy.barCountA(), 3);
assert.deepEqual(strategy.closesA(), [101, 102, 103]);
assert.equal(strategy.barCountB(), 2);
assert.equal(strategy.autoExecute, false);

assert.equal(strategy.zScore([1, 1, 1]), 0);
assert.ok(strategy.zScore([1, 2, 3]) > 0);
assert.equal(strategy.hedgeRatio([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 2);
assert.equal(Number.isFinite(strategy.halfLife([3, 2, 1, 0, -1, 0, 1, 2, 1, 0])), true);

const signal = strategy.signal("open_spread", "zscore", "buy", "sell");
assert.equal(signal.time, "2026-05-20T00:00:00.000Z");
assert.equal(signal.autoExecute, false);
assert.equal(signal.legA.qty, 2);
assert.equal(signal.legB.direction, "sell");
assert.equal(strategy.popSignals().length, 1);
assert.equal(strategy.popSignals().length, 0);

process.stdout.write("capital strategy arbitrage base check PASS\n");
