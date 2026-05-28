#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-adapter-ack-operator-apply-plan-latest.json",
);
const REQUIRED_CHECKS = new Set([
  "verifier:ready-or-applied",
  "verdict:known-active-state",
  "paths:source-destination-backup-temp-distinct",
  "backup:path-under-staging-and-hash-named",
  "temp:path-next-to-destination-and-hash-named",
  "commands:repo-root-qualified",
  "safety:dry-run-plan-only",
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
const plan = report.operatorApplyPlan ?? {};

assert.equal(report.schema, "openclaw.capital.adapter-ack-operator-apply-plan.v1");
assert.ok(
  ["ready_atomic_apply_plan", "already_applied_verified", "no_apply_required", "blocked"].includes(
    report.status,
  ),
);
assert.equal(report.mode, "operator_adapter_atomic_apply_plan_report_only");
assert.equal(plan.schema, "openclaw.capital.external-broker-adapter-ack-operator-apply-plan.v1");
assert.equal(plan.status, report.status);
assert.equal(plan.owner, "operator-owned-broker-adapter-only");
assert.equal(plan.dryRunOnly, true);
assert.equal(typeof plan.sourcePath, "string");
assert.equal(typeof plan.destinationPath, "string");
assert.equal(typeof plan.backupPath, "string");
assert.equal(typeof plan.tempPath, "string");
assert.notEqual(plan.sourcePath, plan.destinationPath);
assert.notEqual(plan.destinationPath, plan.backupPath);
assert.notEqual(plan.destinationPath, plan.tempPath);
assert.equal(typeof plan.currentContentSha256, "string");
assert.equal(typeof plan.candidateContentSha256, "string");
assert.ok(plan.backupPath.includes(plan.currentContentSha256));
assert.ok(plan.tempPath.includes(plan.candidateContentSha256));
assert.ok(Array.isArray(plan.preconditions));
assert.ok(
  plan.preconditions.includes("operator_adapter_must_atomic_replace_destination_from_temp"),
);
assert.ok(Array.isArray(plan.orderedDryRunOperations));
const orderedDryRunOperationOrders = plan.orderedDryRunOperations.map((item) => item.order);
assert.deepEqual(
  orderedDryRunOperationOrders,
  orderedDryRunOperationOrders.toSorted((left, right) => left - right),
);
assert.ok(
  plan.orderedDryRunOperations.some((item) => item.id === "plan_atomic_replace_active_ack"),
);
assertRepoRootPnpmCommand(plan.validationCommands?.applyPlan, "plan.validationCommands.applyPlan");
assertRepoRootPnpmCommand(
  plan.validationCommands?.applyVerifier,
  "plan.validationCommands.applyVerifier",
);
assertRepoRootPnpmCommand(
  plan.validationCommands?.adapterAck,
  "plan.validationCommands.adapterAck",
);
assertRepoRootPnpmCommand(
  plan.validationCommands?.liveReadiness,
  "plan.validationCommands.liveReadiness",
);
assert.equal(plan.safety?.generatedPlanOnly, true);
assert.equal(plan.safety?.wroteActiveAdapterAck, false);
assert.equal(plan.safety?.wroteBackup, false);
assert.equal(plan.safety?.wroteTemp, false);
assert.equal(plan.safety?.brokerWriteAttempted, false);
assert.equal(plan.safety?.sentOrder, false);
assert.equal(plan.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.generatedPlanOnly, true);
assert.equal(report.safety?.wroteActiveAdapterAck, false);
assert.equal(report.safety?.wroteBackup, false);
assert.equal(report.safety?.wroteTemp, false);
assert.equal(report.safety?.brokerWriteAttempted, false);
assert.equal(report.safety?.writeBrokerOrders, false);
assert.equal(report.safety?.liveTradingEnabled, false);
assert.equal(report.safety?.sentOrder, false);
assert.equal(report.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.no_live_order_sent, true);
assert.match(report.machineLine, /capitalAdapterAckApplyPlan=/);
assert.match(report.machineLine, /noOrderWrite=true/);
assert.match(report.machineLine, /sentOrder=false/);

for (const id of REQUIRED_CHECKS) {
  assert.ok(checkById.has(id), `missing check ${id}`);
}

if (report.status === "ready_atomic_apply_plan") {
  assert.equal(report.blockers.length, 0);
  assert.equal(plan.applyAllowedByPlan, true);
  assert.equal(plan.alreadyAppliedVerified, false);
} else if (report.status === "already_applied_verified") {
  assert.equal(report.blockers.length, 0);
  assert.equal(plan.applyAllowedByPlan, false);
  assert.equal(plan.alreadyAppliedVerified, true);
} else if (report.status === "no_apply_required") {
  assert.equal(report.blockers.length, 0);
  assert.equal(plan.applyAllowedByPlan, false);
  assert.equal(plan.alreadyAppliedVerified, false);
  assert.equal(plan.noApplyRequired, true);
} else {
  assert.ok(report.blockers.length > 0);
}

if (report.status !== "blocked") {
  for (const id of REQUIRED_CHECKS) {
    assert.equal(checkById.get(id)?.status, "pass", `check failed: ${id}`);
  }
}

await fs.access(report.paths.planPath);
await fs.access(report.paths.reportPath);
await fs.access(report.paths.panelPath);
await fs.access(report.paths.markdownPath);

process.stdout.write(
  [
    "CAPITAL_ADAPTER_ACK_OPERATOR_APPLY_PLAN_CHECK=OK",
    `status=${report.status}`,
    `sha256=${report.sealedIntentSha256}`,
    `applyAllowedByPlan=${plan.applyAllowedByPlan}`,
    `alreadyAppliedVerified=${plan.alreadyAppliedVerified}`,
    `no_live_order_sent=${report.safety.no_live_order_sent}`,
    `blockers=${report.blockers.length}`,
  ].join("\n") + "\n",
);
