#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-position-snapshot-refresh-gate-latest.json",
);
const REQUIRED_CHECKS = new Set([
  "snapshot:active-path-present",
  "snapshot:usable-verified",
  "snapshot:fresh-within-max-age",
  "handoff:active-write-suppressed",
  "handoff:allowed-writer-operator-position-query",
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

assert.equal(report.schema, "openclaw.capital.position-snapshot-refresh-gate.v1");
assert.ok(
  ["fresh_verified", "stale_refresh_required", "missing_or_invalid_refresh_required"].includes(
    report.status,
  ),
);
assert.equal(report.mode, "operator_owned_position_snapshot_refresh_report_only");
assert.equal(report.positionSnapshot?.schema, "openclaw.capital.verified-position-snapshot.v1");
assert.equal(typeof report.positionSnapshot?.usable, "boolean");
assert.ok(["fresh", "stale", ""].includes(report.positionSnapshot?.freshnessStatus));
assert.equal(typeof report.positionSnapshot?.path, "string");
assert.equal(typeof report.positionSnapshot?.verifiedAt, "string");
assert.equal(typeof report.positionSnapshot?.verifiedBy, "string");
assert.equal(typeof report.positionSnapshot?.hasOpenPosition, "boolean");
assert.equal(typeof report.positionSnapshot?.netContracts, "number");
assert.equal(typeof report.operatorRefresh?.status, "string");
assert.equal(typeof report.operatorRefresh?.operatorMayRefresh, "boolean");
assert.equal(report.operatorRefresh?.activeSnapshotWriteSuppressed, true);
assert.equal(report.operatorRefresh?.conversationAgentsMayWriteActiveSnapshot, false);
assert.equal(report.operatorRefresh?.allowedWriter, "operator-owned-position-query-only");
assert.equal(
  report.stagedRefreshCandidate?.schema,
  "openclaw.capital.verified-position-snapshot.v1",
);
assert.equal(report.stagedRefreshCandidate?.verified, false);
assert.equal(report.stagedRefreshCandidate?.activeSnapshotWriteSuppressed, true);
assert.equal(report.stagedRefreshCandidate?.allowedWriter, "operator-owned-position-query-only");
assert.ok(Array.isArray(report.stagedRefreshCandidate?.positions));
assert.ok(Array.isArray(report.operatorRefresh?.handoffChecklist));
assert.ok(Array.isArray(report.blockers));
assert.match(report.machineLine, /capitalPositionSnapshotRefresh=/);
assert.match(report.machineLine, /noOrderWrite=true/);
assert.match(report.machineLine, /sentOrder=false/);
assert.equal(typeof report.nextSafeTask, "string");
assert.notEqual(report.nextSafeTask.trim(), "");

for (const [key, command] of Object.entries(report.validationCommands ?? {})) {
  assertRepoRootPnpmCommand(command, `validationCommands.${key}`);
}
for (const id of REQUIRED_CHECKS) {
  assert.ok(checkById.has(id), `missing check ${id}`);
}

assert.equal(report.safety?.reportOnly, true);
assert.equal(report.safety?.generatedRefreshCandidateOnly, true);
assert.equal(report.safety?.wroteActiveSnapshot, false);
assert.equal(report.safety?.brokerApiCalled, false);
assert.equal(report.safety?.brokerWriteAttempted, false);
assert.equal(report.safety?.writeBrokerOrders, false);
assert.equal(report.safety?.liveTradingEnabled, false);
assert.equal(report.safety?.sentOrder, false);
assert.equal(report.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.no_live_order_sent, true);

if (report.status === "fresh_verified") {
  assert.equal(report.positionSnapshot.freshnessStatus, "fresh");
  assert.equal(report.operatorRefresh.operatorMayRefresh, false);
  assert.equal(report.blockers.length, 0);
  for (const id of REQUIRED_CHECKS) {
    assert.equal(checkById.get(id)?.status, "pass", `check failed: ${id}`);
  }
} else {
  assert.ok(report.blockers.length > 0);
  if (report.status === "stale_refresh_required") {
    assert.equal(report.positionSnapshot.usable, true);
    assert.equal(report.positionSnapshot.freshnessStatus, "stale");
    assert.equal(report.operatorRefresh.operatorMayRefresh, true);
  }
}

await fs.access(report.paths.reportPath);
await fs.access(report.paths.markdownPath);
await fs.access(report.paths.panelPath);
await fs.access(report.paths.stagedRefreshPath);

process.stdout.write(
  [
    "CAPITAL_POSITION_SNAPSHOT_REFRESH_GATE_CHECK=OK",
    `status=${report.status}`,
    `freshness=${report.positionSnapshot.freshnessStatus}`,
    `age=${report.positionSnapshot.verifiedAgeSeconds}`,
    `operatorMayRefresh=${report.operatorRefresh.operatorMayRefresh}`,
    "no_live_order_sent=true",
    `blockers=${report.blockers.length}`,
  ].join("\n") + "\n",
);
