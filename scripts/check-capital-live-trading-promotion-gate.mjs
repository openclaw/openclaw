import assert from "node:assert/strict";
import { runCapitalLiveTradingPromotionGate } from "./openclaw-capital-live-trading-promotion-gate.mjs";

const { report } = await runCapitalLiveTradingPromotionGate({
  writeState: true,
});

assert.equal(report.schema, "openclaw.capital.live-trading-promotion-gate.v1");
assert.equal(report.mode, "live_promotion_review");
assert.equal(report.status, "blocked");
assert.equal(report.liveTradingEnabled, false);
assert.equal(report.writeTradingEnabled, false);
assert.equal(report.externalWriteEnabled, false);
assert.equal(report.brokerOrderPathEnabled, false);
assert.equal(report.loginAttempted, false);
assert.equal(report.sentOrder, false);
assert.equal(report.safety.allowLiveTrading, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.promoteLiveAutomatically, false);
assert.equal(report.safety.readOnlyPreflightOnly, true);
assert.deepEqual(report.requestedCapabilities, ["live_api", "send_order", "external_write"]);
assert.deepEqual(report.deniedCapabilities, ["live_api", "send_order", "external_write"]);
assert.ok(Array.isArray(report.checks));
assert.ok(report.checks.length >= 10);
assert.ok(Array.isArray(report.blockers));
assert.ok(report.blockers.length >= 1);
assert.ok(report.checks.some((item) => item.id === "live:simulation-sweep-present"));
assert.ok(report.checks.some((item) => item.id === "live:simulation-safety-lock"));
assert.ok(report.checks.some((item) => item.id === "live:simulation-risk-gate-clear"));
assert.ok(report.checks.some((item) => item.id === "live:walk-forward-gate-clear"));
assert.ok(report.checks.some((item) => item.id === "live:full-chain-dryrun-fault-gate-clear"));
if (report.inputs?.simulationPath) {
  assert.equal(typeof report.inputs.simulationPath, "string");
}
if (report.inputs?.walkForwardPath) {
  assert.equal(typeof report.inputs.walkForwardPath, "string");
}
if (report.inputs?.fullChainPath) {
  assert.equal(typeof report.inputs.fullChainPath, "string");
}
assert.ok(
  ["LIVE_TRADING_PROMOTION_PRECONDITIONS_FAILED", "LIVE_TRADING_MANUAL_REVIEW_REQUIRED"].includes(
    report.blockerCode,
  ),
);
assert.equal(typeof report.nextSafeTask, "string");
assert.notEqual(report.nextSafeTask.length, 0);

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_PROMOTION_GATE_CHECK=OK",
    `status=${report.status}`,
    `blockerCode=${report.blockerCode}`,
    `readyForManualReview=${report.readyForManualReview}`,
    `blockers=${report.blockers.join(",")}`,
  ].join("\n") + "\n",
);
