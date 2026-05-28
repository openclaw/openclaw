#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-adapter-ack-hash-handoff-verifier-latest.json",
);
const ALLOWED_STATUSES = new Set([
  "ready_for_operator_handoff",
  "verified_no_handoff_required",
  "blocked",
]);
const REQUIRED_CHECKS = new Set([
  "sealed-intent:present",
  "active-ack:path-present",
  "staged-candidate:path-present",
  "hash:active-mismatch-detected",
  "hash:candidate-matches-sealed-intent",
  "rollback:candidate-concrete",
  "canary:no-order",
  "rollback:fresh",
  "promotion:safe-to-promote-candidate",
  "safety:active-ack-write-suppressed",
  "safety:no-live-order-sent",
  "commands:repo-root-qualified",
]);

function assertRepoRootPnpmCommand(command, fieldName) {
  assert.match(
    String(command || ""),
    /^pnpm --dir .+ /,
    `${fieldName} must be repo-root qualified`,
  );
}

function assertConcreteIso(value, fieldName) {
  assert.equal(typeof value, "string", `${fieldName} must be a string`);
  assert.notEqual(value, "ISO-8601", `${fieldName} must not be a placeholder`);
  assert.ok(Number.isFinite(Date.parse(value)), `${fieldName} must parse as a timestamp`);
}

const report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
const checks = Array.isArray(report.checks) ? report.checks : [];
const checkById = new Map(checks.map((item) => [item.id, item]));

assert.equal(report.schema, "openclaw.capital.adapter-ack-hash-handoff-verifier.v1");
assert.ok(ALLOWED_STATUSES.has(report.status), `status=${report.status}`);
assert.equal(report.mode, "report_only_operator_ack_hash_handoff");
assert.equal(typeof report.sealedIntentSha256, "string");
assert.equal(report.hash?.expectedSealedIntentSha256, report.sealedIntentSha256);
assert.equal(typeof report.hash?.hashOk, "boolean");
assert.equal(typeof report.hash?.actualSealedIntentSha256, "string");
assert.equal(typeof report.hash?.candidateSealedIntentSha256, "string");
assert.equal(typeof report.hash?.activeAckPath, "string");
assert.equal(typeof report.hash?.stagedCandidateAckPath, "string");
assert.notEqual(report.hash?.activeAckPath, report.hash?.stagedCandidateAckPath);
assert.equal(report.operatorHandoff?.sourcePath, report.hash?.stagedCandidateAckPath);
assert.equal(report.operatorHandoff?.destinationPath, report.hash?.activeAckPath);
assert.equal(report.operatorHandoff?.requiredTemplatePath, report.hash?.requiredTemplatePath);
assert.equal(typeof report.operatorHandoff?.status, "string");
assert.equal(typeof report.operatorHandoff?.canaryPass, "boolean");
assert.equal(typeof report.operatorHandoff?.canarySentOrder, "boolean");
assert.equal(typeof report.operatorHandoff?.rollbackFresh, "boolean");
assert.equal(typeof report.operatorHandoff?.safeToPromoteCandidate, "boolean");
assert.equal(report.operatorHandoff?.activeAckWriteSuppressed, true);
assert.equal(report.operatorHandoff?.conversationAgentsMayWriteActiveAck, false);
assert.equal(report.operatorHandoff?.allowedWriter, "operator-owned-broker-adapter-only");
assert.ok(Array.isArray(report.operatorHandoff?.handoffChecklist));
assert.ok(
  report.operatorHandoff.handoffChecklist.some(
    (item) => item?.id === "operator_owned_active_ack_refresh",
  ),
);
const handoffChecklistOrders = report.operatorHandoff.handoffChecklist.map((item) => item?.order);
assert.deepEqual(
  handoffChecklistOrders,
  handoffChecklistOrders.toSorted((a, b) => a - b),
);
assertRepoRootPnpmCommand(
  report.operatorHandoff?.validationCommands?.adapterAck,
  "operatorHandoff.validationCommands.adapterAck",
);
assertRepoRootPnpmCommand(
  report.operatorHandoff?.validationCommands?.liveReadiness,
  "operatorHandoff.validationCommands.liveReadiness",
);
assertRepoRootPnpmCommand(
  report.operatorHandoff?.validationCommands?.operatorPacket,
  "operatorHandoff.validationCommands.operatorPacket",
);
assert.equal(report.safety?.generatedReportOnly, true);
assert.equal(report.safety?.wroteActiveAdapterAck, false);
assert.equal(report.safety?.brokerWriteAttempted, false);
assert.equal(report.safety?.writeBrokerOrders, false);
assert.equal(report.safety?.liveTradingEnabled, false);
assert.equal(report.safety?.conversationAgentDirectBrokerWrite, false);
assert.equal(report.safety?.sentOrder, false);
assert.equal(report.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.no_live_order_sent, true);
assert.match(report.machineLine, /capitalAdapterAckHandoff=/);
assert.match(report.machineLine, /noOrderWrite=true/);
assert.match(report.machineLine, /sentOrder=false/);

for (const id of REQUIRED_CHECKS) {
  assert.ok(checkById.has(id), `missing check ${id}`);
}

if (report.operatorHandoff?.safeToPromoteCandidate === true) {
  assertConcreteIso(
    report.operatorHandoff?.candidateRollbackVerifiedAt,
    "operatorHandoff.candidateRollbackVerifiedAt",
  );
}

if (report.status === "ready_for_operator_handoff") {
  assert.equal(report.blockers.length, 0);
  assert.equal(report.hash.hashOk, false);
  assert.notEqual(report.hash.expectedSealedIntentSha256, report.hash.actualSealedIntentSha256);
  assert.equal(report.hash.candidateSealedIntentSha256, report.hash.expectedSealedIntentSha256);
  assert.equal(report.hash.activeHashMismatchDetected, true);
  assert.equal(report.hash.candidateMatchesSealedIntent, true);
  assert.equal(report.operatorHandoff.status, "ready_for_operator_owned_ack_refresh");
  assert.equal(report.operatorHandoff.safeToPromoteCandidate, true);
  assert.equal(report.operatorHandoff.canarySentOrder, false);
  assert.equal(report.operatorHandoff.rollbackFresh, true);
  assert.ok(
    report.operatorHandoff.handoffChecklist.some(
      (item) =>
        item?.id === "operator_owned_active_ack_refresh" &&
        item?.status === "pending_operator_owned_adapter",
    ),
  );
  for (const id of REQUIRED_CHECKS) {
    assert.equal(checkById.get(id)?.status, "pass", `check failed: ${id}`);
  }
} else if (report.status === "verified_no_handoff_required") {
  assert.equal(report.blockers.length, 0);
  assert.equal(report.hash.hashOk, true);
  assert.equal(report.operatorHandoff.status, "not_required");
} else {
  assert.ok(report.blockers.length > 0);
}

await fs.access(report.paths.reportPath);
await fs.access(report.paths.panelPath);
await fs.access(report.paths.markdownPath);

process.stdout.write(
  [
    "CAPITAL_ADAPTER_ACK_HASH_HANDOFF_VERIFIER_CHECK=OK",
    `status=${report.status}`,
    `sha256=${report.sealedIntentSha256}`,
    `hashOk=${report.hash.hashOk}`,
    `safeToPromoteCandidate=${report.operatorHandoff.safeToPromoteCandidate}`,
    `no_live_order_sent=${report.safety.no_live_order_sent}`,
    `blockers=${report.blockers.length}`,
  ].join("\n") + "\n",
);
