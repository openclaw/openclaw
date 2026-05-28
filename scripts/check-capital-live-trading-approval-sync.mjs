import assert from "node:assert/strict";
import { syncCapitalLiveTradingApproval } from "./openclaw-capital-live-trading-approval-sync.mjs";

const { approval, report } = await syncCapitalLiveTradingApproval({
  writeState: true,
});

assert.equal(report.schema, "openclaw.capital.live-trading-approval-sync.v1");
assert.ok(
  report.status === "synced" || report.status === "synced_with_existing_allowlist_fallback",
);
assert.ok(report.accountAllowlistCount > 0);
assert.equal(approval.schema, "openclaw.capital.live-trading-approval.v1");
assert.ok(Array.isArray(approval.accountAllowlist));
assert.equal(approval.accountAllowlist.length, report.accountAllowlistCount);
if (report.status === "synced") {
  assert.equal(approval.accountAllowlistSource, "auto_detected_from_hft_service_status");
  assert.equal(approval.autoDetectedAccountCount, report.accountAllowlistCount);
} else {
  assert.ok(
    approval.accountAllowlistSource === "manual_or_previous_allowlist" ||
      approval.accountAllowlistSource === "auto_detected_from_hft_service_status",
  );
  assert.ok(approval.autoDetectedAccountCount >= 0);
  assert.ok(approval.autoDetectedAccountCount <= report.accountAllowlistCount);
}
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
  assert.equal(report.preservedManualApproval, true);
} else {
  assert.equal(approval.manualAccountReviewRequired, true);
  assert.equal(approval.approvalStatus, "template_pending_manual_review");
  assert.equal(approval.killSwitch, false);
  assert.equal(approval.reviewChecklist.manualOperatorConfirmed, false);
}

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_APPROVAL_SYNC_CHECK=OK",
    `accountAllowlist=${report.accountAllowlistCount}`,
    `humanApproved=${approval.humanApproved}`,
    "live/write/order=OFF",
  ].join("\n") + "\n",
);
