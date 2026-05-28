#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-external-broker-adapter-ack-gate-latest.json",
);
const ALLOWED_STATUSES = new Set(["blocked", "verified"]);
const REQUIRED_CHECKS = new Set([
  "sealed-intent:present",
  "ack:active-file-exists",
  "ack:schema",
  "ack:owner",
  "ack:sealed-intent-hash-match",
  "ack:canary-dry-run-pass",
  "ack:rollback-pass",
  "ack:rollback-freshness",
  "safety:no-live-order-sent",
  "safety:active-ack-not-written-by-this-gate",
]);

const report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
const checks = Array.isArray(report.checks) ? report.checks : [];
const checkById = new Map(checks.map((item) => [item.id, item]));

function assertRepoRootPnpmCommand(command, fieldName) {
  assert.match(
    String(command || ""),
    /^pnpm --dir .+ /,
    `${fieldName} must be repo-root qualified`,
  );
}

assert.equal(report.schema, "openclaw.capital.external-broker-adapter-ack-gate.v1");
assert.ok(ALLOWED_STATUSES.has(report.status), `status=${report.status}`);
assert.equal(typeof report.sealedIntentSha256, "string");
assert.notEqual(report.sealedIntentSha256.length, 0);
assert.equal(report.ack?.expectedValue?.sealedIntentSha256, report.sealedIntentSha256);
assert.equal(report.ack?.sealedIntentHash?.expected, report.sealedIntentSha256);
assert.equal(typeof report.ack?.sealedIntentHash?.actual, "string");
assert.equal(typeof report.ack?.sealedIntentHash?.matched, "boolean");
assert.equal(typeof report.ack?.sealedIntentHash?.mismatch, "boolean");
assert.equal(typeof report.ack?.sealedIntentHash?.operatorAction, "string");
assert.equal(
  report.ack?.sealedIntentHash?.requiredTemplatePath,
  report.paths?.requiredTemplatePath,
);
assert.equal(report.ack?.expectedValue?.canary?.dryRun, true);
assert.equal(report.ack?.expectedValue?.canary?.sentOrder, false);
assert.equal(typeof report.operatorReview?.status, "string");
assert.equal(report.operatorReview?.candidateAck?.sealedIntentSha256, report.sealedIntentSha256);
assert.equal(report.operatorReview?.stagedCandidateAckPath, report.paths?.stagedCandidateAckPath);
assert.equal(report.operatorReview?.requiredTemplatePath, report.paths?.requiredTemplatePath);
assert.equal(
  report.operatorReview?.activeVsCandidate?.stagedCandidateAckPath,
  report.paths?.stagedCandidateAckPath,
);
assert.equal(
  report.operatorReview?.activeVsCandidate?.activeAckPath,
  report.operatorReview?.activeAckPath,
);
assert.ok(
  ["matching", "mismatch"].includes(report.operatorReview?.activeVsCandidate?.status),
  `activeVsCandidate.status=${report.operatorReview?.activeVsCandidate?.status}`,
);
assert.ok(Array.isArray(report.operatorReview?.activeVsCandidate?.fields));
assert.ok(
  report.operatorReview.activeVsCandidate.fields.some(
    (item) => item?.field === "sealedIntentSha256",
  ),
);
assert.ok(
  report.operatorReview.activeVsCandidate.fields.some(
    (item) => item?.field === "rollback.verifiedAt",
  ),
);
assert.ok(
  ["not_required", "operator_refresh_required"].includes(
    report.operatorReview?.refreshPlan?.status,
  ),
);
assert.equal(report.operatorReview?.refreshPlan?.sourcePath, report.paths?.stagedCandidateAckPath);
assert.equal(
  report.operatorReview?.refreshPlan?.destinationPath,
  report.operatorReview?.activeAckPath,
);
assert.equal(
  report.operatorReview?.refreshPlan?.expectedSealedIntentSha256,
  report.sealedIntentSha256,
);
assert.equal(
  report.operatorReview?.refreshPlan?.candidateSealedIntentSha256,
  report.sealedIntentSha256,
);
assert.equal(
  report.operatorReview?.refreshPlan?.candidateRollbackVerifiedAt,
  report.ack?.rollbackVerifiedAt,
);
assert.equal(typeof report.operatorReview?.refreshPlan?.safeToPromoteCandidate, "boolean");
assert.equal(report.operatorReview?.refreshPlan?.activeAckWriteSuppressed, true);
assert.equal(report.operatorReview?.refreshPlan?.conversationAgentsMayWriteActiveAck, false);
assert.equal(
  report.operatorReview?.refreshPlan?.allowedWriter,
  "operator-owned-broker-adapter-only",
);
assert.equal(
  report.operatorReview?.refreshPlan?.validationCommand?.endsWith(
    " capital:trade:adapter-ack:check",
  ),
  true,
);
assert.equal(
  report.operatorReview?.refreshPlan?.postRefreshValidationCommand?.endsWith(
    " capital:live-readiness:check",
  ),
  true,
);
assertRepoRootPnpmCommand(
  report.operatorReview?.refreshPlan?.validationCommand,
  "operatorReview.refreshPlan.validationCommand",
);
assertRepoRootPnpmCommand(
  report.operatorReview?.refreshPlan?.postRefreshValidationCommand,
  "operatorReview.refreshPlan.postRefreshValidationCommand",
);
assert.ok(Array.isArray(report.operatorReview?.handoffChecklist));
assert.ok(report.operatorReview.handoffChecklist.length >= 5);
const handoffChecklistOrders = report.operatorReview.handoffChecklist.map((item) => item?.order);
assert.deepEqual(
  handoffChecklistOrders,
  handoffChecklistOrders.toSorted((a, b) => a - b),
);
assert.ok(
  report.operatorReview.handoffChecklist.some(
    (item) => item?.id === "operator_owned_active_ack_refresh",
  ),
);
assert.notEqual(
  report.operatorReview?.stagedCandidateAckPath,
  report.operatorReview?.activeAckPath,
);
assert.equal(report.operatorReview?.activeAckWriteSuppressed, true);
assert.equal(report.operatorReview?.conversationAgentsMayWriteActiveAck, false);
assert.equal(report.operatorReview?.allowedWriter, "operator-owned-broker-adapter-only");
assert.equal(
  report.operatorReview?.validationCommand?.endsWith(" capital:trade:adapter-ack:check"),
  true,
);
assertRepoRootPnpmCommand(
  report.operatorReview?.validationCommand,
  "operatorReview.validationCommand",
);
assert.equal(report.safety?.generatedTemplateOnly, true);
assert.equal(report.safety?.generatedStagedCandidateAck, true);
assert.equal(report.safety?.wroteActiveAdapterAck, false);
assert.equal(report.safety?.activeAckWriteSuppressed, true);
assert.equal(report.safety?.brokerWriteAttempted, false);
assert.equal(report.safety?.writeBrokerOrders, false);
assert.equal(report.safety?.liveTradingEnabled, false);
assert.equal(report.safety?.sentOrder, false);
assert.equal(report.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.no_live_order_sent, true);
assert.match(report.machineLine, /capitalAdapterAck=/);
assert.match(report.machineLine, /canarySentOrder=/);
assert.match(report.machineLine, /rollbackFresh=/);
assert.match(report.machineLine, /noOrderWrite=true/);
assert.match(report.machineLine, /sentOrder=false/);
assert.equal(typeof report.ack?.canaryDryRun, "boolean");
assert.equal(typeof report.ack?.canarySentOrder, "boolean");
assert.equal(typeof report.ack?.rollbackPass, "boolean");
assert.equal(typeof report.ack?.rollbackFresh, "boolean");
assert.ok(["fresh", "stale"].includes(report.ack?.rollbackFreshnessStatus));
assert.equal(report.ack?.rollbackMaxFreshSeconds, 43200);
if (report.ack?.rollbackVerifiedAt) {
  assert.equal(typeof report.ack?.rollbackAgeSeconds, "number");
  assert.ok(Number.isFinite(report.ack.rollbackAgeSeconds));
}

for (const id of REQUIRED_CHECKS) {
  assert.ok(checkById.has(id), `missing check ${id}`);
}
if (report.status === "verified") {
  assert.equal(report.blockers.length, 0);
  assert.equal(report.ack.usable, true);
  for (const id of REQUIRED_CHECKS) {
    assert.equal(checkById.get(id)?.status, "pass", `check failed: ${id}`);
  }
} else {
  assert.ok(report.blockers.length > 0);
  assert.equal(report.ack.usable, false);
}
if (checkById.get("ack:sealed-intent-hash-match")?.status !== "pass") {
  assert.ok(report.blockers.includes("ack:sealed-intent-hash-match"));
  assert.equal(report.ack?.sealedIntentHash?.matched, false);
  assert.equal(report.ack?.sealedIntentHash?.mismatch, true);
  assert.match(report.ack?.sealedIntentHash?.operatorAction, /required-current template/);
  assert.equal(report.operatorReview?.activeVsCandidate?.status, "mismatch");
  assert.equal(report.operatorReview?.refreshPlan?.status, "operator_refresh_required");
  assert.equal(report.operatorReview?.refreshPlan?.reason, "active_ack_hash_mismatch");
  assert.equal(
    report.operatorReview?.refreshPlan?.safeToPromoteCandidate,
    report.ack?.rollbackFresh === true,
  );
  assert.ok(
    report.operatorReview.handoffChecklist.some(
      (item) =>
        item?.id === "operator_owned_active_ack_refresh" &&
        item?.status === "pending_operator_owned_adapter",
    ),
  );
}
if (checkById.get("ack:rollback-freshness")?.status !== "pass") {
  assert.ok(report.blockers.includes("ack:rollback-freshness"));
}

await fs.access(report.paths.reportPath);
await fs.access(report.paths.panelPath);
await fs.access(report.paths.markdownPath);
await fs.access(report.paths.requiredTemplatePath);
await fs.access(report.paths.stagedCandidateAckPath);

const stagedCandidateAck = JSON.parse(
  await fs.readFile(report.paths.stagedCandidateAckPath, "utf8"),
);
assert.equal(stagedCandidateAck.sealedIntentSha256, report.sealedIntentSha256);
assert.equal(stagedCandidateAck.canary?.dryRun, true);
assert.equal(stagedCandidateAck.canary?.sentOrder, false);
assert.equal(stagedCandidateAck.rollback?.verifiedAt, report.ack?.rollbackVerifiedAt);
assert.notEqual(stagedCandidateAck.rollback?.verifiedAt, "ISO-8601");
if (report.operatorReview?.refreshPlan?.safeToPromoteCandidate === true) {
  assert.match(
    stagedCandidateAck.rollback?.verifiedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    "safe-to-promote candidate must carry concrete rollback verification time",
  );
}

process.stdout.write(
  [
    "CAPITAL_EXTERNAL_BROKER_ADAPTER_ACK_GATE_CHECK=OK",
    `status=${report.status}`,
    `sha256=${report.sealedIntentSha256}`,
    `ack=${report.ack.status}`,
    `hashOk=${report.ack.hashOk}`,
    "no_live_order_sent=true",
    `blockers=${report.blockers.length}`,
  ].join("\n") + "\n",
);
