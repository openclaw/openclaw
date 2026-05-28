import assert from "node:assert/strict";
import { BaseStrategy } from "./strategy-engine/BaseStrategy.mjs";

const strategy = new BaseStrategy({
  name: "base-check",
  instrument: "TX06AM",
  broker: "capital",
  auto: true,
  maxQty: 2,
  params: { threshold: 3 },
});

assert.equal(strategy.autoExecute, false);
assert.equal(strategy.requestedAutoExecute, true);
assert.equal(strategy.maxQty, 2);

strategy.addBar({ open: 10, high: 12, low: 9, close: 11, volume: 5 });
strategy.addBar({ open: 11, high: 13, low: 10, close: 12, volume: 8 });

assert.deepEqual(strategy.closes(), [11, 12]);
assert.deepEqual(strategy.highs(), [12, 13]);
assert.deepEqual(strategy.lows(), [9, 10]);
assert.deepEqual(strategy.volumes(), [5, 8]);
assert.equal(strategy.barCount(), 2);
assert.equal(strategy.lastN(1, strategy.closes())[0], 12);

const signal = strategy.signal("buy", "unit-check");
assert.equal(signal.schema, "openclaw.capital.strategy-intent.v1");
assert.equal(signal.autoExecute, false);
assert.equal(signal.requestedAutoExecute, true);
assert.equal(signal.paperOnly, true);
assert.equal(signal.allowLiveTrading, false);
assert.equal(signal.writeBrokerOrders, false);
assert.equal(signal.qty, 2);

assert.equal(strategy.popSignals().length, 1);
assert.equal(strategy.popSignals().length, 0);

strategy.onFill({ direction: "buy", qty: 1 });
assert.equal(strategy.isLong(), true);
assert.equal(strategy.isFlat(), false);

const changed = strategy.updateParams({ threshold: 4 }, { auto: true, maxQty: 3 });
assert.equal(changed.length, 1);
assert.equal(strategy.params.threshold, 4);
assert.equal(strategy.maxQty, 3);
assert.equal(strategy.autoExecute, false);
assert.equal(strategy.requestedAutoExecute, true);

process.stdout.write("capital strategy base interface check PASS\n");
