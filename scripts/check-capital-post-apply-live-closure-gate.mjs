#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-post-apply-live-closure-gate-latest.json",
);
const ALLOWED_STATUSES = new Set([
  "blocked_post_apply_closure_incomplete",
  "blocked_safety_reconcile_required",
  "closed_ready_for_operator_final_review",
]);
const REQUIRED_CHECKS = new Set([
  "adapter-apply:receipt-verified",
  "adapter-apply:verified-active-candidate",
  "live-readiness:operator-execution-review-ready",
  "local-executor:dispatch-final-confirmation-ready",
  "commands:repo-root-qualified",
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

assert.equal(report.schema, "openclaw.capital.post-apply-live-closure-gate.v1");
assert.ok(ALLOWED_STATUSES.has(report.status), `status=${report.status}`);
assert.equal(report.mode, "post_apply_live_closure_report_only");
assert.equal(typeof report.sealedIntentSha256, "string");
assert.notEqual(report.sealedIntentSha256.length, 0);
assert.equal(typeof report.operatorCanExecute, "boolean");
assert.equal(typeof report.adapterApply?.verified, "boolean");
assert.equal(typeof report.adapterApply?.verifierStatus, "string");
assert.equal(typeof report.adapterApply?.activeState, "string");
assert.equal(typeof report.adapterApply?.operatorApplyVerified, "boolean");
assert.equal(typeof report.applyPlan?.status, "string");
assert.equal(typeof report.applyPlan?.applyAllowedByPlan, "boolean");
assert.equal(typeof report.applyPlan?.alreadyAppliedVerified, "boolean");
assert.equal(typeof report.adapterApplyReceipt?.verified, "boolean");
assert.equal(typeof report.adapterApplyReceipt?.status, "string");
assert.equal(typeof report.adapterApplyReceipt?.action, "string");
assert.equal(typeof report.adapterApplyReceipt?.operatorMayApply, "boolean");
assert.equal(typeof report.adapterApplyReceipt?.operatorApplyVerified, "boolean");
assert.equal(typeof report.adapterApplyReceipt?.applyAllowedByPlan, "boolean");
assert.equal(typeof report.adapterApplyReceipt?.alreadyAppliedVerified, "boolean");
assert.equal(typeof report.adapterApplyReceipt?.activeState, "string");
assert.equal(typeof report.adapterApplyReceipt?.sourcePath, "string");
assert.equal(typeof report.adapterApplyReceipt?.destinationPath, "string");
assert.equal(typeof report.adapterApplyReceipt?.nextSafeTask, "string");
assert.equal(typeof report.liveReadiness?.ready, "boolean");
assert.equal(typeof report.liveReadiness?.status, "string");
assert.equal(typeof report.liveReadiness?.operatorCanExecute, "boolean");
assert.equal(typeof report.liveReadiness?.incompleteCount, "number");
assert.ok(Array.isArray(report.liveReadiness?.incompleteChecklist));
assert.ok(Array.isArray(report.liveReadiness?.nextCommands));
assert.equal(typeof report.localExecutorDispatch?.ready, "boolean");
assert.equal(typeof report.localExecutorDispatch?.status, "string");
assert.equal(typeof report.localExecutorDispatch?.dispatchPolicy, "string");
assert.ok(Array.isArray(report.localExecutorDispatch?.blockers));
assert.ok(Array.isArray(report.blockers));
assert.equal(report.commandSurface?.schema, "openclaw.command-surface.repo-root-pnpm.v1");
assert.equal(report.commandSurface?.repoRoot, process.cwd());
assert.equal(report.commandSurface?.noPkgManifestAvoided, true);

for (const [key, command] of Object.entries(report.validationCommands ?? {})) {
  assertRepoRootPnpmCommand(command, `validationCommands.${key}`);
}
for (const command of report.liveReadiness.nextCommands) {
  assertRepoRootPnpmCommand(command, "liveReadiness.nextCommands[]");
}

assert.equal(report.safety?.reportOnly, true);
assert.equal(report.safety?.generatedClosureOnly, true);
assert.equal(report.safety?.wroteActiveAdapterAck, false);
assert.equal(report.safety?.wroteBrokerCommand, false);
assert.equal(report.safety?.brokerApiCalled, false);
assert.equal(report.safety?.brokerWriteAttempted, false);
assert.equal(report.safety?.writeBrokerOrders, false);
assert.equal(report.safety?.liveTradingEnabled, false);
assert.equal(report.safety?.conversationAgentDirectBrokerWrite, false);
assert.equal(report.safety?.containsCredentials, false);
assert.equal(report.safety?.sentOrder, false);
assert.equal(report.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.no_live_order_sent, true);
assert.match(report.machineLine, /capitalPostApplyClosure=/);
assert.match(report.machineLine, /adapterApplyVerified=/);
assert.match(report.machineLine, /adapterApplyReceiptVerified=/);
assert.match(report.machineLine, /liveReadinessReady=/);
assert.match(report.machineLine, /localDispatchReady=/);
assert.match(report.machineLine, /operatorCanExecute=/);
assert.match(report.machineLine, /noLiveOrderSent=true/);
assert.match(report.machineLine, /sentOrder=false/);
assert.match(report.machineLine, /noOrderWrite=true/);
assert.equal(typeof report.nextSafeTask, "string");
assert.notEqual(report.nextSafeTask.trim(), "");

for (const id of REQUIRED_CHECKS) {
  assert.ok(checkById.has(id), `missing check ${id}`);
}

if (report.status === "closed_ready_for_operator_final_review") {
  assert.equal(report.operatorCanExecute, true);
  assert.equal(report.adapterApplyReceipt.verified, true);
  assert.equal(report.adapterApply.verified, true);
  assert.equal(report.liveReadiness.ready, true);
  assert.equal(report.localExecutorDispatch.ready, true);
  assert.equal(report.safety.localBrokerExecutorWriteAllowedAfterGates, true);
  assert.equal(report.blockers.length, 0);
  for (const id of REQUIRED_CHECKS) {
    assert.equal(checkById.get(id)?.status, "pass", `check failed: ${id}`);
  }
} else {
  assert.equal(report.operatorCanExecute, false);
  assert.ok(report.blockers.length > 0);
  assert.equal(report.safety.localBrokerExecutorWriteAllowedAfterGates, false);
}

await fs.access(report.paths.reportPath);
await fs.access(report.paths.markdownPath);
await fs.access(report.paths.panelPath);

process.stdout.write(
  [
    "CAPITAL_POST_APPLY_LIVE_CLOSURE_GATE_CHECK=OK",
    `status=${report.status}`,
    `sha256=${report.sealedIntentSha256}`,
    `adapterApplyVerified=${report.adapterApply.verified}`,
    `adapterApplyReceiptVerified=${report.adapterApplyReceipt.verified}`,
    `liveReadinessReady=${report.liveReadiness.ready}`,
    `localDispatchReady=${report.localExecutorDispatch.ready}`,
    `operatorCanExecute=${report.operatorCanExecute}`,
    "no_live_order_sent=true",
    `blockers=${report.blockers.length}`,
  ].join("\n") + "\n",
);
