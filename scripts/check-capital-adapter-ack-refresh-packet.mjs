#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-adapter-ack-refresh-packet-latest.json",
);
const REQUIRED_CHECKS = new Set([
  "handoff:ready",
  "source:readable",
  "destination:readable",
  "source:json",
  "destination:json",
  "hash:candidate-matches-sealed-intent",
  "hash:active-still-mismatched",
  "rollback:candidate-concrete",
  "safety:no-live-order-sent",
  "safety:active-ack-write-suppressed",
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

assert.equal(report.schema, "openclaw.capital.adapter-ack-refresh-packet.v1");
assert.ok(
  ["ready_for_operator_adapter_apply", "no_refresh_required", "blocked"].includes(report.status),
);
assert.equal(report.mode, "operator_adapter_refresh_packet_report_only");
assert.equal(
  report.refreshPacket?.schema,
  "openclaw.capital.external-broker-adapter-ack-refresh-packet.v1",
);
assert.equal(report.refreshPacket?.owner, "operator-owned-broker-adapter-only");
assert.equal(report.refreshPacket?.sourcePath, report.paths?.sourcePath);
assert.equal(report.refreshPacket?.destinationPath, report.paths?.destinationPath);
assert.equal(report.refreshPacket?.backupPath, report.paths?.backupPath);
assert.notEqual(report.refreshPacket?.sourcePath, report.refreshPacket?.destinationPath);
assert.equal(report.refreshPacket?.sealedIntentSha256, report.sealedIntentSha256);
assert.equal(report.refreshPacket?.candidateSealedIntentSha256, report.sealedIntentSha256);
if (report.status === "ready_for_operator_adapter_apply") {
  assert.notEqual(report.refreshPacket?.activeSealedIntentSha256, report.sealedIntentSha256);
} else if (report.status === "no_refresh_required") {
  assert.equal(report.refreshPacket?.activeSealedIntentSha256, report.sealedIntentSha256);
}
assert.equal(typeof report.refreshPacket?.currentContentSha256, "string");
assert.equal(typeof report.refreshPacket?.candidateContentSha256, "string");
if (report.status === "ready_for_operator_adapter_apply") {
  assert.notEqual(
    report.refreshPacket?.currentContentSha256,
    report.refreshPacket?.candidateContentSha256,
  );
}
assertConcreteIso(
  report.refreshPacket?.candidateRollbackVerifiedAt,
  "refreshPacket.candidateRollbackVerifiedAt",
);
assert.ok(Array.isArray(report.refreshPacket?.atomicApplyPlan));
if (report.status === "ready_for_operator_adapter_apply") {
  assert.ok(
    report.refreshPacket.atomicApplyPlan.includes(
      "write_candidate_to_destination_path_using_atomic_replace",
    ),
  );
} else if (report.status === "no_refresh_required") {
  assert.ok(
    report.refreshPacket.atomicApplyPlan.includes(
      "no_refresh_required_active_ack_already_matches_sealed_intent",
    ),
  );
}
assertRepoRootPnpmCommand(
  report.refreshPacket?.validationCommands?.handoff,
  "refreshPacket.validationCommands.handoff",
);
assertRepoRootPnpmCommand(
  report.refreshPacket?.validationCommands?.adapterAck,
  "refreshPacket.validationCommands.adapterAck",
);
assertRepoRootPnpmCommand(
  report.refreshPacket?.validationCommands?.liveReadiness,
  "refreshPacket.validationCommands.liveReadiness",
);
assert.equal(report.refreshPacket?.safety?.packetOnly, true);
assert.equal(report.refreshPacket?.safety?.wroteActiveAdapterAck, false);
assert.equal(report.refreshPacket?.safety?.brokerWriteAttempted, false);
assert.equal(report.refreshPacket?.safety?.sentOrder, false);
assert.equal(report.refreshPacket?.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.generatedPacketOnly, true);
assert.equal(report.safety?.wroteActiveAdapterAck, false);
assert.equal(report.safety?.brokerWriteAttempted, false);
assert.equal(report.safety?.writeBrokerOrders, false);
assert.equal(report.safety?.liveTradingEnabled, false);
assert.equal(report.safety?.sentOrder, false);
assert.equal(report.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.no_live_order_sent, true);
assert.match(report.machineLine, /capitalAdapterAckRefreshPacket=/);
assert.match(report.machineLine, /noOrderWrite=true/);
assert.match(report.machineLine, /sentOrder=false/);

for (const id of REQUIRED_CHECKS) {
  assert.ok(checkById.has(id), `missing check ${id}`);
}

if (report.status === "ready_for_operator_adapter_apply") {
  assert.equal(report.blockers.length, 0);
  for (const id of REQUIRED_CHECKS) {
    assert.equal(checkById.get(id)?.status, "pass", `check failed: ${id}`);
  }
} else if (report.status === "no_refresh_required") {
  assert.equal(report.blockers.length, 0);
  for (const id of REQUIRED_CHECKS) {
    assert.equal(checkById.get(id)?.status, "pass", `check failed: ${id}`);
  }
} else {
  assert.ok(report.blockers.length > 0);
}

await fs.access(report.paths.packetPath);
await fs.access(report.paths.reportPath);
await fs.access(report.paths.panelPath);
await fs.access(report.paths.markdownPath);

process.stdout.write(
  [
    "CAPITAL_ADAPTER_ACK_REFRESH_PACKET_CHECK=OK",
    `status=${report.status}`,
    `sha256=${report.sealedIntentSha256}`,
    `candidateContentSha256=${report.refreshPacket.candidateContentSha256}`,
    `currentContentSha256=${report.refreshPacket.currentContentSha256}`,
    `no_live_order_sent=${report.safety.no_live_order_sent}`,
    `blockers=${report.blockers.length}`,
  ].join("\n") + "\n",
);
