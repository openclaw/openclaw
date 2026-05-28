import assert from "node:assert/strict";
import { runCapitalLiveStrategyReadiness } from "./openclaw-capital-live-strategy-readiness.mjs";

const { report } = await runCapitalLiveStrategyReadiness({
  writeState: true,
});

assert.equal(report.schema, "openclaw.capital.live-strategy-readiness.v1");
assert.equal(report.mode, "paper_strategy_ready_live_blocked");
assert.ok(["paper_ready_live_blocked", "blocked"].includes(report.status));
assert.equal(report.capabilities.liveStrategyExecution, false);
assert.equal(report.capabilities.liveTradingExecution, false);
assert.equal(report.capabilities.brokerWriteExecution, false);
assert.equal(report.capabilities.sentOrder, false);
assert.equal(report.safety.allowLiveTrading, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.promoteLiveAutomatically, false);
assert.equal(report.safety.loginAttemptedByThisScript, false);
assert.equal(report.safety.readOnlyPreflightOnly, true);
assert.ok(["blocked", "live_ready"].includes(report.livePromotion.status));
if (report.livePromotion.status === "live_ready") {
  assert.equal(report.livePromotion.readyForManualReview, true);
  assert.equal(report.livePromotion.blockerCode, "LIVE_TRADING_MANUAL_REVIEW_REQUIRED");
}
assert.equal(report.preTradeRisk.clear, true);
assert.equal(report.latencyGap.clear, true);
assert.equal(report.livePromotion.blockers.includes("live:pre-trade-risk-gate-required"), false);
assert.equal(
  report.livePromotion.blockers.includes("live:latency-gap-instrumentation-required"),
  false,
);
if (report.semiApproval.clear === true) {
  assert.equal(report.livePromotion.blockers.includes("live:semi-approval-required"), false);
} else {
  assert.equal(report.livePromotion.blockers.includes("live:semi-approval-required"), true);
}
assert.ok(Array.isArray(report.checks));
assert.ok(report.checks.length >= 10);
assert.equal(typeof report.nextSafeTask, "string");
assert.notEqual(report.nextSafeTask.length, 0);

process.stdout.write(
  [
    "CAPITAL_LIVE_STRATEGY_READINESS_CHECK=OK",
    `status=${report.status}`,
    `paperStrategyExecution=${report.capabilities.paperStrategyExecution}`,
    `liveTradingExecution=${report.capabilities.liveTradingExecution}`,
    `liveBlockerCode=${report.livePromotion.blockerCode}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
