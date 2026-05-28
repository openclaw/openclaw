#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate-latest.json",
);
const REQUIRED_CHECKS = new Set([
  "source:schema",
  "source:audit-id-present",
  "source:heartbeat-execute-blocked",
  "receipt:pending-or-verified",
  "receipt:matches-audit",
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

assert.equal(
  report.schema,
  "openclaw.capital.live-trading-operator-auto-deactivate-receipt-gate.v1",
);
assert.ok(
  [
    "pending_explicit_execute_receipt",
    "receipt_verified",
    "blocked_receipt_gate_incomplete",
  ].includes(report.status),
);
assert.match(report.auditId, /^capital-auto-deactivate-[a-f0-9]{20}$/);
assert.equal(report.heartbeatExecuteAllowed, false);
assert.equal(report.safety?.reportOnly, true);
assert.equal(report.safety?.heartbeatExecuteAllowed, false);
assert.equal(report.safety?.sentOrder, false);
assert.equal(report.safety?.writeBrokerOrders, false);
assert.equal(report.safety?.liveTradingEnabled, false);
assert.equal(report.safety?.noLiveOrderSent, true);
assert.match(report.machineLine, /capitalAutoDeactivateReceipt=/);
assert.match(report.machineLine, /heartbeatExecuteAllowed=false/);
assert.match(report.machineLine, /noOrderWrite=true/);
assert.match(report.machineLine, /sentOrder=false/);
assertRepoRootPnpmCommand(report.validationCommands?.receiptGate, "validationCommands.receiptGate");
assertRepoRootPnpmCommand(
  report.validationCommands?.autoDeactivate,
  "validationCommands.autoDeactivate",
);
assertRepoRootPnpmCommand(
  report.validationCommands?.controlledRun,
  "validationCommands.controlledRun",
);

for (const id of REQUIRED_CHECKS) {
  assert.ok(checkById.has(id), `missing check ${id}`);
}

if (report.status === "pending_explicit_execute_receipt") {
  assert.equal(report.pendingExplicitExecuteReceipt, true);
  assert.equal(report.receiptVerified, false);
  assert.ok(report.blockers.includes("operator-auto-deactivate:execute-receipt-pending"));
  assert.match(report.nextSafeTask, /explicit non-heartbeat operator execute/);
  for (const id of REQUIRED_CHECKS) {
    assert.equal(checkById.get(id)?.status, "pass", `check failed: ${id}`);
  }
} else if (report.status === "receipt_verified") {
  assert.equal(report.pendingExplicitExecuteReceipt, false);
  assert.equal(report.receiptVerified, true);
  assert.equal(report.blockers.length, 0);
  for (const id of REQUIRED_CHECKS) {
    assert.equal(checkById.get(id)?.status, "pass", `check failed: ${id}`);
  }
} else {
  assert.ok(report.blockers.length > 0);
}

await fs.access(REPORT_PATH);
await fs.access(`${REPORT_PATH}.sha256`);

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_OPERATOR_AUTO_DEACTIVATE_RECEIPT_GATE_CHECK=OK",
    `status=${report.status}`,
    `audit=${report.auditId}`,
    `pendingExplicitExecuteReceipt=${report.pendingExplicitExecuteReceipt}`,
    `receiptVerified=${report.receiptVerified}`,
    `noLiveOrderSent=${report.safety.noLiveOrderSent}`,
  ].join("\n") + "\n",
);
