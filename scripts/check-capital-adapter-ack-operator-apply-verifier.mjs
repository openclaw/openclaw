#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-adapter-ack-operator-apply-verifier-latest.json",
);
const REQUIRED_CHECKS = new Set([
  "packet:present",
  "packet:schema",
  "packet:owner",
  "source:readable",
  "destination:readable",
  "source:json",
  "destination:json",
  "source:content-hash-matches-packet",
  "destination:matches-known-packet-state",
  "hash:candidate-matches-sealed-intent",
  "rollback:candidate-concrete",
  "safety:packet-no-order",
  "safety:write-suppressed",
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

assert.equal(report.schema, "openclaw.capital.adapter-ack-operator-apply-verifier.v1");
assert.ok(
  ["ready_for_operator_apply", "applied_verified", "no_apply_required", "blocked"].includes(
    report.status,
  ),
);
assert.equal(report.mode, "operator_owned_adapter_apply_verifier_report_only");
assert.equal(report.applyVerdict?.status, report.status);
assert.equal(report.applyVerdict?.sealedIntentSha256, report.sealedIntentSha256);
assert.equal(typeof report.applyVerdict?.packetPath, "string");
assert.equal(typeof report.applyVerdict?.sourcePath, "string");
assert.equal(typeof report.applyVerdict?.destinationPath, "string");
assert.notEqual(report.applyVerdict?.sourcePath, report.applyVerdict?.destinationPath);
assert.equal(typeof report.applyVerdict?.currentContentSha256, "string");
assert.equal(typeof report.applyVerdict?.candidateContentSha256, "string");
assert.equal(typeof report.applyVerdict?.sourceContentSha256, "string");
assert.equal(typeof report.applyVerdict?.destinationContentSha256, "string");
assert.equal(report.applyVerdict?.sourceContentSha256, report.applyVerdict?.candidateContentSha256);
assert.equal(report.applyVerdict?.sourceSealedIntentSha256, report.sealedIntentSha256);
assertConcreteIso(
  report.applyVerdict?.candidateRollbackVerifiedAt,
  "applyVerdict.candidateRollbackVerifiedAt",
);
assertRepoRootPnpmCommand(
  report.applyVerdict?.validationCommands?.refreshPacket,
  "applyVerdict.validationCommands.refreshPacket",
);
assertRepoRootPnpmCommand(
  report.applyVerdict?.validationCommands?.applyVerifier,
  "applyVerdict.validationCommands.applyVerifier",
);
assertRepoRootPnpmCommand(
  report.applyVerdict?.validationCommands?.adapterAck,
  "applyVerdict.validationCommands.adapterAck",
);
assertRepoRootPnpmCommand(
  report.applyVerdict?.validationCommands?.liveReadiness,
  "applyVerdict.validationCommands.liveReadiness",
);
assert.equal(report.safety?.generatedReportOnly, true);
assert.equal(report.safety?.wroteActiveAdapterAck, false);
assert.equal(report.safety?.brokerWriteAttempted, false);
assert.equal(report.safety?.writeBrokerOrders, false);
assert.equal(report.safety?.liveTradingEnabled, false);
assert.equal(report.safety?.sentOrder, false);
assert.equal(report.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.no_live_order_sent, true);
assert.match(report.machineLine, /capitalAdapterAckOperatorApply=/);
assert.match(report.machineLine, /noOrderWrite=true/);
assert.match(report.machineLine, /sentOrder=false/);

for (const id of REQUIRED_CHECKS) {
  assert.ok(checkById.has(id), `missing check ${id}`);
}

if (report.status === "ready_for_operator_apply") {
  assert.equal(report.blockers.length, 0);
  assert.equal(report.applyVerdict.operatorMayApply, true);
  assert.equal(report.applyVerdict.operatorApplyVerified, false);
  assert.equal(report.applyVerdict.activeState, "pre_apply_current_matches");
  assert.notEqual(
    report.applyVerdict.destinationSealedIntentSha256,
    report.applyVerdict.sealedIntentSha256,
  );
  assert.equal(
    report.applyVerdict.destinationContentSha256,
    report.applyVerdict.currentContentSha256,
  );
} else if (report.status === "applied_verified") {
  assert.equal(report.blockers.length, 0);
  assert.equal(report.applyVerdict.operatorMayApply, false);
  assert.equal(report.applyVerdict.operatorApplyVerified, true);
  assert.equal(report.applyVerdict.activeState, "applied_candidate_matches");
  assert.equal(
    report.applyVerdict.destinationSealedIntentSha256,
    report.applyVerdict.sealedIntentSha256,
  );
  assert.equal(
    report.applyVerdict.destinationContentSha256,
    report.applyVerdict.candidateContentSha256,
  );
} else if (report.status === "no_apply_required") {
  assert.equal(report.blockers.length, 0);
  assert.equal(report.applyVerdict.operatorMayApply, false);
  assert.equal(report.applyVerdict.operatorApplyVerified, false);
  assert.equal(report.applyVerdict.activeState, "pre_apply_current_matches");
  assert.equal(
    report.applyVerdict.destinationSealedIntentSha256,
    report.applyVerdict.sealedIntentSha256,
  );
  assert.equal(
    report.applyVerdict.destinationContentSha256,
    report.applyVerdict.currentContentSha256,
  );
} else {
  assert.ok(report.blockers.length > 0);
}

if (report.status !== "blocked") {
  for (const id of REQUIRED_CHECKS) {
    assert.equal(checkById.get(id)?.status, "pass", `check failed: ${id}`);
  }
}

await fs.access(report.paths.reportPath);
await fs.access(report.paths.panelPath);
await fs.access(report.paths.markdownPath);

process.stdout.write(
  [
    "CAPITAL_ADAPTER_ACK_OPERATOR_APPLY_VERIFIER_CHECK=OK",
    `status=${report.status}`,
    `sha256=${report.sealedIntentSha256}`,
    `activeState=${report.applyVerdict.activeState}`,
    `operatorMayApply=${report.applyVerdict.operatorMayApply}`,
    `operatorApplyVerified=${report.applyVerdict.operatorApplyVerified}`,
    `no_live_order_sent=${report.safety.no_live_order_sent}`,
    `blockers=${report.blockers.length}`,
  ].join("\n") + "\n",
);
