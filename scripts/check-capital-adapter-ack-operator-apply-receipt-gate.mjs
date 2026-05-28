#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-adapter-ack-operator-apply-receipt-gate-latest.json",
);
const REQUIRED_CHECKS = new Set([
  "verifier:ready-or-applied",
  "plan:ready-or-already-applied",
  "receipt:sealed-hash-consistent",
  "receipt:paths-consistent",
  "receipt:content-hashes-consistent",
  "receipt:state-classified",
  "commands:repo-root-qualified",
  "safety:report-only",
  "safety:no-live-order-sent",
]);

function assertRepoRootPnpmCommand(command, fieldName) {
  assert.match(
    String(command || ""),
    /^pnpm --dir .+ /,
    `${fieldName} must be repo-root qualified`,
  );
}

const report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
const checks = Array.isArray(report.checks) ? report.checks : [];
const checkById = new Map(checks.map((item) => [item.id, item]));
const receipt = report.operatorReceipt ?? {};
const handoff = report.operatorHandoff ?? {};

assert.equal(report.schema, "openclaw.capital.adapter-ack-operator-apply-receipt-gate.v1");
assert.ok(
  [
    "pending_operator_apply",
    "applied_receipt_verified",
    "no_apply_required",
    "blocked_apply_receipt_incomplete",
    "blocked_safety_reconcile_required",
  ].includes(report.status),
);
assert.equal(report.mode, "operator_owned_adapter_apply_receipt_gate_report_only");
assert.equal(
  receipt.schema,
  "openclaw.capital.external-broker-adapter-ack-operator-apply-receipt.v1",
);
assert.equal(receipt.status, report.status);
assert.equal(receipt.owner, "operator-owned-broker-adapter-only");
assert.equal(receipt.reportOnly, true);
assert.equal(receipt.sealedIntentSha256, report.sealedIntentSha256);
assert.equal(typeof receipt.sourcePath, "string");
assert.equal(typeof receipt.destinationPath, "string");
assert.notEqual(receipt.sourcePath, receipt.destinationPath);
assert.equal(typeof receipt.backupPath, "string");
assert.equal(typeof receipt.tempPath, "string");
assert.equal(typeof receipt.currentContentSha256, "string");
assert.equal(typeof receipt.candidateContentSha256, "string");
assert.equal(typeof receipt.activeContentSha256, "string");
assert.equal(typeof receipt.noApplyRequired, "boolean");
assertRepoRootPnpmCommand(
  receipt.validationCommands?.receipt,
  "receipt.validationCommands.receipt",
);
assertRepoRootPnpmCommand(
  receipt.validationCommands?.applyVerifier,
  "receipt.validationCommands.applyVerifier",
);
assertRepoRootPnpmCommand(
  receipt.validationCommands?.applyPlan,
  "receipt.validationCommands.applyPlan",
);
assertRepoRootPnpmCommand(
  receipt.validationCommands?.adapterAck,
  "receipt.validationCommands.adapterAck",
);
assertRepoRootPnpmCommand(
  receipt.validationCommands?.postApplyClosure,
  "receipt.validationCommands.postApplyClosure",
);
assertRepoRootPnpmCommand(receipt.validationCommands?.direct, "receipt.validationCommands.direct");
assert.equal(receipt.safety?.reportOnly, true);
assert.equal(receipt.safety?.wroteActiveAdapterAck, false);
assert.equal(receipt.safety?.wroteBackup, false);
assert.equal(receipt.safety?.wroteTemp, false);
assert.equal(receipt.safety?.brokerWriteAttempted, false);
assert.equal(receipt.safety?.writeBrokerOrders, false);
assert.equal(receipt.safety?.liveTradingEnabled, false);
assert.equal(receipt.safety?.sentOrder, false);
assert.equal(receipt.safety?.noLiveOrderSent, true);
assert.equal(handoff.schema, "openclaw.capital.adapter-ack-operator-handoff.v1");
assert.equal(handoff.status, report.status);
assert.equal(handoff.owner, "operator-owned-broker-adapter-only");
assert.equal(handoff.reportOnly, true);
assert.equal(handoff.allowedActor, "operator-controlled-broker-adapter");
assert.ok(Array.isArray(handoff.disallowedActors));
assert.ok(handoff.disallowedActors.includes("openclaw-automation"));
assert.equal(handoff.sourcePath, receipt.sourcePath);
assert.equal(handoff.destinationPath, receipt.destinationPath);
assert.equal(handoff.backupPath, receipt.backupPath);
assert.equal(handoff.tempPath, receipt.tempPath);
assert.equal(handoff.sealedIntentSha256, report.sealedIntentSha256);
assert.ok(Array.isArray(handoff.requiredValidation));
assert.equal(handoff.safety?.brokerOrderWriteAllowed, false);
assert.equal(handoff.safety?.automationMayWriteActiveAck, false);
assert.equal(handoff.safety?.telegramMayWriteActiveAck, false);
assert.equal(handoff.safety?.reportOnly, true);
assert.equal(handoff.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.reportOnly, true);
assert.equal(report.safety?.generatedReceiptOnly, true);
assert.equal(report.safety?.wroteActiveAdapterAck, false);
assert.equal(report.safety?.wroteBackup, false);
assert.equal(report.safety?.wroteTemp, false);
assert.equal(report.safety?.brokerWriteAttempted, false);
assert.equal(report.safety?.writeBrokerOrders, false);
assert.equal(report.safety?.liveTradingEnabled, false);
assert.equal(report.safety?.sentOrder, false);
assert.equal(report.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.no_live_order_sent, true);
assert.match(report.machineLine, /capitalAdapterAckApplyReceipt=/);
assert.match(report.machineLine, /noOrderWrite=true/);
assert.match(report.machineLine, /sentOrder=false/);

for (const id of REQUIRED_CHECKS) {
  assert.ok(checkById.has(id), `missing check ${id}`);
}

if (report.status === "pending_operator_apply") {
  assert.ok(report.blockers.includes("operator-apply:pending"));
  assert.equal(receipt.action, "operator_apply_required");
  assert.equal(receipt.operatorMayApply, true);
  assert.equal(receipt.operatorApplyVerified, false);
  assert.equal(receipt.applyAllowedByPlan, true);
  assert.equal(receipt.alreadyAppliedVerified, false);
  assert.equal(receipt.activeState, "pre_apply_current_matches");
  assert.equal(handoff.nextAction, "operator_adapter_atomic_apply");
} else if (report.status === "applied_receipt_verified") {
  assert.equal(report.blockers.length, 0);
  assert.equal(receipt.action, "post_apply_closure_required");
  assert.equal(receipt.operatorMayApply, false);
  assert.equal(receipt.operatorApplyVerified, true);
  assert.equal(receipt.applyAllowedByPlan, false);
  assert.equal(receipt.alreadyAppliedVerified, true);
  assert.equal(receipt.noApplyRequired, false);
  assert.equal(receipt.activeState, "applied_candidate_matches");
  assert.equal(handoff.nextAction, "rerun_post_apply_closure");
} else if (report.status === "no_apply_required") {
  assert.equal(report.blockers.length, 0);
  assert.equal(receipt.action, "no_apply_required_post_apply_closure");
  assert.equal(receipt.operatorMayApply, false);
  assert.equal(receipt.operatorApplyVerified, false);
  assert.equal(receipt.applyAllowedByPlan, false);
  assert.equal(receipt.alreadyAppliedVerified, false);
  assert.equal(receipt.noApplyRequired, true);
  assert.equal(receipt.activeState, "pre_apply_current_matches");
  assert.equal(handoff.nextAction, "rerun_post_apply_closure");
} else {
  assert.ok(report.blockers.length > 0);
  assert.equal(receipt.action, "fix_receipt_blockers");
  assert.equal(handoff.nextAction, "fix_receipt_blockers");
}

if (
  report.status === "pending_operator_apply" ||
  report.status === "applied_receipt_verified" ||
  report.status === "no_apply_required"
) {
  for (const id of REQUIRED_CHECKS) {
    assert.equal(checkById.get(id)?.status, "pass", `check failed: ${id}`);
  }
}

await fs.access(report.paths.reportPath);
await fs.access(report.paths.panelPath);
await fs.access(report.paths.markdownPath);

process.stdout.write(
  [
    "CAPITAL_ADAPTER_ACK_OPERATOR_APPLY_RECEIPT_CHECK=OK",
    `status=${report.status}`,
    `sha256=${report.sealedIntentSha256}`,
    `operatorMayApply=${receipt.operatorMayApply}`,
    `operatorApplyVerified=${receipt.operatorApplyVerified}`,
    `no_live_order_sent=${report.safety.no_live_order_sent}`,
    `blockers=${report.blockers.length}`,
  ].join("\n") + "\n",
);
