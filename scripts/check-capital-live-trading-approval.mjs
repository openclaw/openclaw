import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncCapitalLiveTradingApproval } from "./openclaw-capital-live-trading-approval-sync.mjs";
import { runCapitalLiveTradingPromotionGate } from "./openclaw-capital-live-trading-promotion-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const approvalPath = path.join(repoRoot, "config", "capital-live-trading-approval.json");

await syncCapitalLiveTradingApproval({
  approvalPath,
  writeState: true,
});

const approval = JSON.parse(await fs.readFile(approvalPath, "utf8"));

assert.equal(approval.schema, "openclaw.capital.live-trading-approval.v1");
assert.ok(Array.isArray(approval.accountAllowlist));
assert.ok(approval.accountAllowlist.length > 0);
assert.equal(approval.accountAllowlistSource, "auto_detected_from_hft_service_status");
assert.equal(approval.autoDetectedAccountCount, approval.accountAllowlist.length);
assert.equal(typeof approval.reviewChecklist, "object");
assert.equal(typeof approval.safety, "object");
assert.equal(approval.safety.allowLiveTrading, false);
assert.equal(approval.safety.writeBrokerOrders, false);
assert.equal(approval.safety.sentOrder, false);
assert.equal(approval.safety.createdByAutomation, true);
assert.equal(approval.safety.manualEditRequired, true);

if (approval.humanApproved === true) {
  assert.equal(approval.manualAccountReviewRequired, false);
  assert.equal(approval.killSwitch, true);
  assert.ok(typeof approval.rollbackPlan === "string" && approval.rollbackPlan.trim().length > 0);
  assert.equal(approval.reviewChecklist.manualOperatorConfirmed, true);
} else {
  assert.equal(approval.manualAccountReviewRequired, true);
  assert.equal(approval.approvalStatus, "template_pending_manual_review");
  assert.equal(approval.killSwitch, false);
  assert.equal(approval.rollbackPlan, "");
  assert.equal(approval.reviewChecklist.manualOperatorConfirmed, false);
}

const { report } = await runCapitalLiveTradingPromotionGate({
  approvalPath,
  writeState: true,
});

assert.equal(report.status, "blocked");
assert.equal(
  report.readyForManualReview,
  report.blockerCode === "LIVE_TRADING_MANUAL_REVIEW_REQUIRED",
);
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
assert.ok(
  ["LIVE_TRADING_PROMOTION_PRECONDITIONS_FAILED", "LIVE_TRADING_MANUAL_REVIEW_REQUIRED"].includes(
    report.blockerCode,
  ),
);
assert.equal(report.blockers.includes("live:account-allowlist"), false);
if (approval.humanApproved === true) {
  assert.equal(report.blockers.includes("live:human-approval-pending"), false);
  assert.equal(report.blockers.includes("live:kill-switch-and-rollback"), false);
} else {
  assert.ok(report.blockers.includes("live:human-approval-pending"));
  assert.ok(report.blockers.includes("live:kill-switch-and-rollback"));
}

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_APPROVAL_CHECK=OK",
    `humanApproved=${approval.humanApproved}`,
    `accountAllowlist=${approval.accountAllowlist.length}`,
    `status=${report.status}`,
    `readyForManualReview=${report.readyForManualReview}`,
    `blockerCode=${report.blockerCode}`,
    `blockers=${report.blockers.join(",")}`,
  ].join("\n") + "\n",
);
