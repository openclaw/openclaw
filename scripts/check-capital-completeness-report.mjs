import assert from "node:assert/strict";
import { runCapitalCompletenessReport } from "./openclaw-capital-completeness-report.mjs";

const { report } = await runCapitalCompletenessReport({
  writeState: true,
});

assert.equal(report.schema, "openclaw.capital.completeness-report.v1");
assert.ok(["paper_ready_live_blocked", "blocked"].includes(report.status));
assert.equal(report.headline.liveTradingReady, false);
assert.equal(report.headline.brokerWriteReady, false);
assert.equal(report.headline.safeToEnableLiveNow, false);
assert.ok(Array.isArray(report.completed));
assert.ok(report.completed.length >= 6);
assert.ok(Array.isArray(report.aborted));
assert.ok(report.aborted.length >= 3);
assert.ok(Array.isArray(report.planned));
assert.ok(report.planned.length >= 3);
assert.ok(Array.isArray(report.unfinished));
assert.equal(
  report.unfinished.some((item) => /LatencyMonitor|GapDetector/u.test(item.item)),
  false,
);
const liveBlockers = report.evidence.readiness.liveBlockers ?? [];
const hasSemiApprovalUnfinished = report.unfinished.some((item) =>
  item.item.includes("SEMI approval"),
);
const hasLiveApprovalUnfinished = report.unfinished.some((item) =>
  item.item.includes("live approval"),
);
const hasCallbackStaleUnfinished = report.unfinished.some((item) =>
  item.item.includes("callback readback stale symbols"),
);
const actionableStaleSymbolCount = Array.isArray(
  report.evidence.callbackReadback.actionableStaleSymbols,
)
  ? report.evidence.callbackReadback.actionableStaleSymbols.length
  : 0;
const staleRequiresAction =
  report.evidence.callbackReadback.quoteFreshAllowed === false && actionableStaleSymbolCount > 0;
const approvalCompleted =
  report.evidence.approval.humanApproved === true &&
  (report.evidence.approval.accountAllowlistCount ?? 0) > 0 &&
  report.evidence.approval.killSwitch === true &&
  report.evidence.approval.hasRollbackPlan === true;
assert.equal(hasSemiApprovalUnfinished, liveBlockers.includes("live:semi-approval-required"));
assert.equal(hasLiveApprovalUnfinished, !approvalCompleted);
assert.equal(hasCallbackStaleUnfinished, staleRequiresAction);
const minimumUnfinishedCount =
  Number(hasSemiApprovalUnfinished) +
  Number(hasLiveApprovalUnfinished) +
  Number(hasCallbackStaleUnfinished);
assert.ok(report.unfinished.length >= minimumUnfinishedCount);
assert.ok(Array.isArray(report.verificationChecklist));
assert.ok(report.verificationChecklist.length >= 5);
assert.equal(report.evidence.preTradeRiskWiring.status, "wired");
assert.equal(report.evidence.latencyGapInstrumentation.status, "passed");
assert.equal(report.evidence.overseasRotation.status, "passed");
assert.ok(report.evidence.overseasRotation.pageCount > 1);
assert.ok(report.evidence.overseasRotation.maxPageSize <= 64);
assert.equal(
  report.unfinished.some((item) => /Overseas product rotation|64 SKOS/u.test(item.item)),
  false,
);
assert.equal(
  report.evidence.readiness.liveBlockers.includes("live:pre-trade-risk-gate-required"),
  false,
);
assert.equal(
  report.evidence.readiness.liveBlockers.includes("live:latency-gap-instrumentation-required"),
  false,
);

process.stdout.write(
  [
    "CAPITAL_COMPLETENESS_REPORT_CHECK=OK",
    `status=${report.status}`,
    `paperStrategyReady=${report.headline.paperStrategyReady}`,
    `liveTradingReady=${report.headline.liveTradingReady}`,
    `unfinished=${report.unfinished.length}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
