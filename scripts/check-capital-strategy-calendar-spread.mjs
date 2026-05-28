import assert from "node:assert/strict";
import { CalendarSpreadStrategy } from "./strategy-engine/arbitrage/CalendarSpreadStrategy.mjs";

const fixedNow = () => new Date("2026-05-20T00:00:00.000Z");
const strategy = new CalendarSpreadStrategy({
  name: "calendar-check",
  auto: true,
  allowAutoExecute: false,
  now: fixedNow,
  params: { lookback: 5, minBars: 10, entryZ: 1.5, exitZ: 0.5 },
  legA: { instrument: "TX_NEAR", broker: "paper", maxQty: 2 },
  legB: { instrument: "TX_FAR", broker: "paper", maxQty: 2 },
});

const spreads = [0, 0, 0, 0, 0, 0, 0, 0, 0, 10];
for (const spread of spreads) {
  strategy.onBarA({ close: 100 + spread });
  strategy.onBarB({ close: 100 });
}

let signals = strategy.popSignals();
assert.equal(signals.length, 1);
assert.equal(signals[0].direction, "open_spread");
assert.equal(signals[0].legA.direction, "sell");
assert.equal(signals[0].legB.direction, "buy");
assert.equal(signals[0].autoExecute, false);
assert.equal(strategy.isOpen(), true);

for (const spread of [1, 1, 1]) {
  strategy.onBarA({ close: 100 + spread });
  strategy.onBarB({ close: 100 });
}

signals = strategy.popSignals();
assert.equal(signals.length, 1);
assert.equal(signals[0].direction, "close_spread");
assert.equal(signals[0].legA.direction, "buy");
assert.equal(signals[0].legB.direction, "sell");
assert.equal(strategy.isOpen(), false);

process.stdout.write("capital strategy calendar spread check PASS\n");
