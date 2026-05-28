import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const sourceApprovalPath = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const scriptPath = path.join(
  repoRoot,
  "scripts",
  "openclaw-capital-live-trading-operator-auto-deactivate.mjs",
);

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "openclaw-capital-operator-auto-deactivate-"),
);
const fixtureApprovalPath = path.join(tempDir, "capital-live-trading-approval.fixture.json");
const fixtureRiskControlsPath = path.join(tempDir, "risk-controls.fixture.json");
const fixtureReportPath = path.join(tempDir, "operator-auto-deactivate-report.fixture.json");

await fs.copyFile(sourceApprovalPath, fixtureApprovalPath);
await fs.writeFile(
  fixtureRiskControlsPath,
  `${JSON.stringify(
    {
      allowLiveTrading: true,
      writeBrokerOrders: true,
      liveActivation: {
        enabled: true,
        activatedAt: "2026-05-24T00:00:00.000Z",
        expiresAt: "2026-05-24T01:00:00.000Z",
        ttlMinutes: 60,
        operator: "fixture-operator",
        reason: "fixture-activation",
        source: "fixture",
      },
      liveDeactivation: { enabled: false },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

function runJson(args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `command failed: node ${path.basename(scriptPath)} ${args.join(" ")}`,
        `status=${result.status}`,
        `stdout=${result.stdout || ""}`,
        `stderr=${result.stderr || ""}`,
      ].join("\n"),
    );
  }
  return JSON.parse(result.stdout);
}

const dryRun = runJson([
  "--approval",
  fixtureApprovalPath,
  "--risk-controls",
  fixtureRiskControlsPath,
  "--report",
  fixtureReportPath,
  "--operator",
  "fixture-operator",
  "--write-state",
  "--json",
]);

assert.equal(dryRun.schema, "openclaw.capital.live-trading-operator-auto-deactivate.v1");
assert.equal(dryRun.status, "ready_to_deactivate");
assert.equal(dryRun.applied, false);
assert.equal(dryRun.enabledAfter, true);
assert.equal(dryRun.activationExpired, true);
assert.equal(dryRun.activationExpiresAt, "2026-05-24T01:00:00.000Z");
assert.equal(dryRun.sentOrder, false);
assert.equal(dryRun.noOrderWrite, true);
assert.equal(dryRun.operatorActionRequired, true);
assert.equal(
  dryRun.operatorActionCommand,
  "pnpm capital:live-trading:operator:auto-deactivate:execute",
);
assert.equal(dryRun.operatorActionReason, "expired_live_write_still_enabled");
assert.match(dryRun.operatorActionAuditId, /^capital-auto-deactivate-[a-f0-9]{20}$/);
assert.equal(dryRun.operatorActionRequiresExplicitExecute, true);
assert.equal(dryRun.operatorActionHeartbeatExecuteAllowed, false);
assert.equal(dryRun.operatorActionAudit.id, dryRun.operatorActionAuditId);
assert.equal(
  dryRun.operatorActionAudit.command,
  "pnpm capital:live-trading:operator:auto-deactivate:execute",
);
assert.equal(dryRun.operatorActionAudit.requiresExplicitExecute, true);
assert.equal(dryRun.operatorActionAudit.heartbeatExecuteAllowed, false);
assert.match(dryRun.operatorActionAudit.approvalSha256Before, /^[A-F0-9]{64}$/);
assert.match(dryRun.operatorActionAudit.riskControlsSha256Before, /^[A-F0-9]{64}$/);
await fs.access(fixtureReportPath);
await fs.access(`${fixtureReportPath}.sha256`);
const dryRunReport = JSON.parse(await fs.readFile(fixtureReportPath, "utf8"));
assert.equal(dryRunReport.schema, "openclaw.capital.live-trading-operator-auto-deactivate.v1");
assert.equal(dryRunReport.status, "ready_to_deactivate");
assert.equal(dryRunReport.enabledAfter, true);
assert.equal(dryRunReport.activationExpired, true);
assert.equal(dryRunReport.activationExpiresAt, "2026-05-24T01:00:00.000Z");
assert.equal(dryRunReport.sentOrder, false);
assert.equal(dryRunReport.noOrderWrite, true);
assert.equal(dryRunReport.operatorActionRequired, true);
assert.equal(
  dryRunReport.operatorActionCommand,
  "pnpm capital:live-trading:operator:auto-deactivate:execute",
);
assert.equal(dryRunReport.operatorActionReason, "expired_live_write_still_enabled");
assert.equal(dryRunReport.operatorActionAuditId, dryRun.operatorActionAuditId);
assert.equal(dryRunReport.operatorActionRequiresExplicitExecute, true);
assert.equal(dryRunReport.operatorActionHeartbeatExecuteAllowed, false);
assert.equal(dryRunReport.operatorActionAudit.id, dryRun.operatorActionAuditId);
assert.equal(dryRunReport.operatorActionAudit.requiresExplicitExecute, true);
assert.equal(dryRunReport.operatorActionAudit.heartbeatExecuteAllowed, false);
assert.equal(dryRunReport.gateReport?.schema, "openclaw.capital.live-trading-operator-gate.v1");
assert.equal(dryRunReport.gateReport?.safety?.sentOrder, false);

const executeRun = runJson([
  "--approval",
  fixtureApprovalPath,
  "--risk-controls",
  fixtureRiskControlsPath,
  "--report",
  fixtureReportPath,
  "--operator",
  "fixture-operator",
  "--reason",
  "fixture-final-deactivate",
  "--execute",
  "--write-state",
  "--json",
]);

assert.equal(executeRun.schema, "openclaw.capital.live-trading-operator-auto-deactivate.v1");
assert.equal(executeRun.status, "deactivated");
assert.equal(executeRun.applied, true);
assert.equal(executeRun.enabledAfter, false);
assert.equal(executeRun.activationExpired, true);
assert.equal(executeRun.activationExpiresAt, "2026-05-24T01:00:00.000Z");
assert.equal(executeRun.sentOrder, false);
assert.equal(executeRun.noOrderWrite, true);
assert.equal(executeRun.operatorActionRequired, false);
assert.equal(executeRun.operatorActionCommand, "");
assert.equal(executeRun.operatorActionReason, "");
assert.equal(executeRun.operatorActionAuditId, dryRun.operatorActionAuditId);
assert.equal(executeRun.operatorActionRequiresExplicitExecute, false);
assert.equal(executeRun.operatorActionHeartbeatExecuteAllowed, false);
assert.equal(executeRun.operatorActionAudit, null);
assert.equal(executeRun.operatorActionReceipt.id, dryRun.operatorActionAuditId);
assert.equal(
  executeRun.operatorActionReceipt.command,
  "pnpm capital:live-trading:operator:auto-deactivate:execute",
);
assert.equal(executeRun.operatorActionReceipt.reason, "expired_live_write_still_enabled");
assert.equal(executeRun.operatorActionReceipt.executeReason, "fixture-final-deactivate");
assert.equal(executeRun.operatorActionReceipt.applied, true);
assert.equal(executeRun.operatorActionReceipt.status, "deactivated");
assert.equal(executeRun.operatorActionReceipt.riskControlsChanged, true);
assert.equal(executeRun.operatorActionReceipt.before.allowLiveTrading, true);
assert.equal(executeRun.operatorActionReceipt.before.writeBrokerOrders, true);
assert.equal(executeRun.operatorActionReceipt.before.liveActivationEnabled, true);
assert.equal(executeRun.operatorActionReceipt.after.allowLiveTrading, false);
assert.equal(executeRun.operatorActionReceipt.after.writeBrokerOrders, false);
assert.equal(executeRun.operatorActionReceipt.after.liveActivationEnabled, false);
assert.equal(executeRun.operatorActionReceipt.after.liveDeactivationEnabled, true);
assert.equal(
  executeRun.operatorActionReceipt.rollbackPolicy,
  "manual_only_do_not_auto_reenable_live_write",
);
assert.equal(executeRun.operatorActionReceipt.sentOrder, false);
assert.equal(executeRun.operatorActionReceipt.noOrderWrite, true);
assert.match(executeRun.operatorActionReceipt.approvalSha256Before, /^[A-F0-9]{64}$/);
assert.match(executeRun.operatorActionReceipt.riskControlsSha256Before, /^[A-F0-9]{64}$/);
assert.match(executeRun.operatorActionReceipt.riskControlsSha256After, /^[A-F0-9]{64}$/);
assert.notEqual(
  executeRun.operatorActionReceipt.riskControlsSha256Before,
  executeRun.operatorActionReceipt.riskControlsSha256After,
);
const executeReport = JSON.parse(await fs.readFile(fixtureReportPath, "utf8"));
assert.equal(executeReport.schema, "openclaw.capital.live-trading-operator-auto-deactivate.v1");
assert.equal(executeReport.status, "deactivated");
assert.equal(executeReport.enabledAfter, false);
assert.equal(executeReport.activationExpired, true);
assert.equal(executeReport.activationExpiresAt, "2026-05-24T01:00:00.000Z");
assert.equal(executeReport.sentOrder, false);
assert.equal(executeReport.noOrderWrite, true);
assert.equal(executeReport.operatorActionRequired, false);
assert.equal(executeReport.operatorActionCommand, "");
assert.equal(executeReport.operatorActionReason, "");
assert.equal(executeReport.operatorActionAuditId, dryRun.operatorActionAuditId);
assert.equal(executeReport.operatorActionRequiresExplicitExecute, false);
assert.equal(executeReport.operatorActionHeartbeatExecuteAllowed, false);
assert.equal(executeReport.operatorActionAudit, null);
assert.equal(executeReport.operatorActionReceipt.id, dryRun.operatorActionAuditId);
assert.equal(executeReport.operatorActionReceipt.riskControlsChanged, true);
assert.equal(
  executeReport.operatorActionReceipt.rollbackPolicy,
  "manual_only_do_not_auto_reenable_live_write",
);
assert.equal(executeReport.operatorActionReceipt.sentOrder, false);
assert.equal(executeReport.operatorActionReceipt.noOrderWrite, true);
assert.equal(executeReport.gateReport?.safety?.sentOrder, false);

const riskAfter = JSON.parse(await fs.readFile(fixtureRiskControlsPath, "utf8"));
assert.equal(riskAfter.allowLiveTrading, false);
assert.equal(riskAfter.writeBrokerOrders, false);
assert.equal(riskAfter.liveActivation.enabled, false);
assert.equal(riskAfter.liveDeactivation.enabled, true);
assert.equal(riskAfter.liveDeactivation.reason, "fixture-final-deactivate");

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_OPERATOR_AUTO_DEACTIVATE_CHECK=OK",
    `dryRun=${dryRun.status}`,
    `execute=${executeRun.status}`,
    `enabledAfter=${executeRun.enabledAfter}`,
    `activationExpired=${executeRun.activationExpired}`,
    `sentOrder=${executeRun.sentOrder}`,
    `noOrderWrite=${executeRun.noOrderWrite}`,
    `operatorActionRequired=${executeRun.operatorActionRequired}`,
  ].join("\n") + "\n",
);
