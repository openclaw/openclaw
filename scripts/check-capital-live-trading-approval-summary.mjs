import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { buildCapitalLiveTradingApprovalSummary } from "./openclaw-capital-live-trading-approval-summary.mjs";

const repoRoot = process.cwd();
const jsonPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-approval-summary-latest.json",
);
const mdPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-approval-summary-latest.md",
);

const report = await buildCapitalLiveTradingApprovalSummary({
  writeGateState: true,
});

assert.equal(report.schema, "openclaw.capital.live-trading-approval-summary.v1");
assert.ok(
  [
    "blocked_pending_manual_approval",
    "manual_review_required",
    "live_enabled_manual_window",
  ].includes(report.status),
);
assert.equal(report.language, "zh-TW");
assert.ok(report.approval.accountAllowlistCount > 0);
assert.equal(report.approval.accountAllowlistSource, "auto_detected_from_hft_service_status");
assert.ok(Number.isInteger(report.approval.autoDetectedAccountCount));
assert.ok(report.approval.autoDetectedAccountCount >= 0);
assert.ok(report.approval.autoDetectedAccountCount <= report.approval.accountAllowlistCount);
if (report.approval.humanApproved === true) {
  assert.equal(report.approval.manualAccountReviewRequired, false);
  assert.equal(report.approval.killSwitch, true);
  assert.equal(report.approval.rollbackPlanFilled, true);
  assert.equal(report.approval.manualOperatorConfirmed, true);
} else {
  assert.equal(report.approval.manualAccountReviewRequired, true);
  assert.equal(report.approval.killSwitch, false);
  assert.equal(report.approval.rollbackPlanFilled, false);
}
assert.equal(report.liveGate.status, "blocked");
assert.equal(typeof report.liveGate.readyForManualReview, "boolean");
if (report.approval.humanApproved === true) {
  assert.equal(report.liveGate.blockers.includes("live:human-approval-pending"), false);
  assert.equal(report.liveGate.blockers.includes("live:kill-switch-and-rollback"), false);
} else {
  assert.equal(report.liveGate.readyForManualReview, false);
  assert.ok(report.liveGate.blockers.includes("live:human-approval-pending"));
  assert.ok(report.liveGate.blockers.includes("live:kill-switch-and-rollback"));
}
assert.equal(report.liveGate.blockers.includes("live:account-allowlist"), false);
if (report.status === "live_enabled_manual_window") {
  assert.equal(report.safety.liveTradingEnabled, true);
  assert.equal(report.safety.writeTradingEnabled, true);
  assert.equal(report.safety.externalWriteEnabled, true);
  assert.equal(report.safety.brokerOrderPathEnabled, true);
  assert.equal(report.safety.readOnlyReportOnly, false);
} else {
  assert.equal(report.safety.liveTradingEnabled, false);
  assert.equal(report.safety.writeTradingEnabled, false);
  assert.equal(report.safety.externalWriteEnabled, false);
  assert.equal(report.safety.brokerOrderPathEnabled, false);
  assert.equal(report.safety.readOnlyReportOnly, true);
}
assert.equal(report.safety.loginAttempted, false);
assert.equal(report.safety.sentOrder, false);
assert.match(report.telegram_summary_oneline_zh_tw, /群益真單=(封鎖|已開啟)/u);
assert.match(report.telegram_summary_oneline_zh_tw, /humanApproved=(true|false)/u);
assert.match(report.telegram_summary_oneline_zh_tw, /accountAllowlist=[1-9][0-9]*/u);
assert.match(report.telegram_summary_oneline_zh_tw, /rollbackPlan=(已填|未填)/u);
assert.match(report.telegram_summary_oneline_zh_tw, /live\/write\/order=(OFF|ON)/u);
if (report.status === "live_enabled_manual_window") {
  assert.match(report.telegram_summary_oneline_zh_tw, /blockers=none/u);
}

await fs.mkdir(path.dirname(jsonPath), { recursive: true });
await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(
  mdPath,
  [
    "# Capital Live Trading Approval Summary",
    "",
    `- status: ${report.status}`,
    `- telegram: ${report.telegram_summary_oneline_zh_tw}`,
    `- liveTradingEnabled: ${report.safety.liveTradingEnabled}`,
    `- writeTradingEnabled: ${report.safety.writeTradingEnabled}`,
    `- sentOrder: ${report.safety.sentOrder}`,
    `- nextSafeTask: ${report.nextSafeTask}`,
    "",
  ].join("\n"),
  "utf8",
);

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_APPROVAL_SUMMARY_CHECK=OK",
    `status=${report.status}`,
    `humanApproved=${report.approval.humanApproved}`,
    `blockers=${report.liveGate.blockers.join(",")}`,
    `telegram=${report.telegram_summary_oneline_zh_tw}`,
  ].join("\n") + "\n",
);
