import assert from "node:assert/strict";
import { buildCapitalLatencyGapInstrumentation } from "./openclaw-capital-latency-gap-instrumentation.mjs";

const report = await buildCapitalLatencyGapInstrumentation({ repoRoot: process.cwd() });

assert.equal(report.schema, "openclaw.capital.latency-gap-instrumentation.v1");
assert.equal(report.status, "passed");
assert.equal(report.staticEvidence.status, "wired");
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.sentOrder, false);
assert.equal(report.staticEvidence.checks.tickToSignalRecordedOnBothFeeds, true);
assert.equal(report.staticEvidence.checks.signalToOrderRecorded, true);
assert.equal(report.staticEvidence.checks.orderRoundTripRecorded, true);
assert.equal(report.staticEvidence.checks.lastPriceFeedsGapDetector, true);
assert.equal(report.staticEvidence.checks.preTradeRiskBlocksGapPause, true);
assert.ok(report.runtimeEvidence.signalTailCount > 0);
assert.ok(report.runtimeEvidence.paperOrderTailCount > 0);

process.stdout.write(
  [
    "CAPITAL_LATENCY_GAP_INSTRUMENTATION_CHECK=OK",
    `status=${report.status}`,
    `latestSignalAt=${report.runtimeEvidence.latestSignalAt || "missing"}`,
    `tickToSignalCalls=${report.staticEvidence.counts.tickToSignalRecordCalls}`,
    `orderRoundTripCalls=${report.staticEvidence.counts.orderRoundTripRecordCalls}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
