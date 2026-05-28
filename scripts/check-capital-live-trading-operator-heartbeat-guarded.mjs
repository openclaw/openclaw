import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGuarded } from "./openclaw-capital-live-trading-operator-heartbeat-guarded.mjs";

const repoRoot = process.cwd();
const sourceApprovalPath = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "openclaw-capital-operator-heartbeat-guarded-"),
);
const fixtureApprovalPath = path.join(tempDir, "capital-live-trading-approval.fixture.json");
const fixtureRiskDisabledPath = path.join(tempDir, "risk-controls.disabled.fixture.json");
const fixtureRiskExpiredPath = path.join(tempDir, "risk-controls.expired.fixture.json");
const fixtureReportPath = path.join(tempDir, "operator-heartbeat-guarded-report.fixture.json");
const fixtureHeartbeatReportPath = path.join(
  tempDir,
  "operator-heartbeat-guarded-heartbeat.fixture.json",
);

await fs.copyFile(sourceApprovalPath, fixtureApprovalPath);

await fs.writeFile(
  fixtureRiskDisabledPath,
  `${JSON.stringify(
    {
      allowLiveTrading: false,
      writeBrokerOrders: false,
      liveActivation: { enabled: false },
      liveDeactivation: { enabled: true },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

await fs.writeFile(
  fixtureRiskExpiredPath,
  `${JSON.stringify(
    {
      allowLiveTrading: true,
      writeBrokerOrders: true,
      liveActivation: {
        enabled: true,
        activatedAt: "2026-05-24T00:00:00.000Z",
        expiresAt: "2026-05-24T00:01:00.000Z",
        ttlMinutes: 1,
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

const disabled = await runGuarded({
  approvalPath: fixtureApprovalPath,
  riskControlsPath: fixtureRiskDisabledPath,
  reportPath: fixtureReportPath,
  heartbeatReportPath: fixtureHeartbeatReportPath,
  intervalSec: 60,
  execute: false,
  writeState: true,
  skipSurfaceCheck: true,
});

assert.equal(disabled.report.schema, "openclaw.capital.live-trading-operator-heartbeat-guarded.v1");
assert.equal(disabled.report.status, "guard_live_disabled_idle");
assert.equal(disabled.report.surfaceCheck.ok, true);
assert.equal(disabled.report.surfaceCheck.skipped, true);
assert.equal(disabled.report.enabledAfter, false);
assert.equal(disabled.report.sentOrder, false);
await fs.access(fixtureReportPath);
await fs.access(`${fixtureReportPath}.sha256`);

const expiredDryRun = await runGuarded({
  approvalPath: fixtureApprovalPath,
  riskControlsPath: fixtureRiskExpiredPath,
  reportPath: fixtureReportPath,
  heartbeatReportPath: fixtureHeartbeatReportPath,
  intervalSec: 60,
  execute: false,
  writeState: true,
  skipSurfaceCheck: true,
});

assert.equal(expiredDryRun.report.status, "guard_expired_pending_reconcile");
assert.equal(expiredDryRun.report.action, "reconcile_expired_activation");
assert.equal(expiredDryRun.report.applied, false);
assert.equal(expiredDryRun.report.enabledAfter, true);
assert.equal(expiredDryRun.report.sentOrder, false);

const expiredExecute = await runGuarded({
  approvalPath: fixtureApprovalPath,
  riskControlsPath: fixtureRiskExpiredPath,
  reportPath: fixtureReportPath,
  heartbeatReportPath: fixtureHeartbeatReportPath,
  intervalSec: 60,
  execute: true,
  writeState: true,
  skipSurfaceCheck: true,
});

assert.equal(expiredExecute.report.status, "guard_expired_reconciled");
assert.equal(expiredExecute.report.action, "reconcile_expired_activation");
assert.equal(expiredExecute.report.applied, true);
assert.equal(expiredExecute.report.enabledAfter, false);
assert.equal(expiredExecute.report.sentOrder, false);

const riskAfter = JSON.parse(await fs.readFile(fixtureRiskExpiredPath, "utf8"));
assert.equal(riskAfter.allowLiveTrading, false);
assert.equal(riskAfter.writeBrokerOrders, false);
assert.equal(riskAfter.liveDeactivation.enabled, true);
assert.equal(riskAfter.liveDeactivation.reason, "activation_ttl_expired");

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_OPERATOR_HEARTBEAT_GUARDED_CHECK=OK",
    `disabled=${disabled.report.status}`,
    `expiredDryRun=${expiredDryRun.report.status}`,
    `expiredExecute=${expiredExecute.report.status}`,
    `enabledAfter=${expiredExecute.report.enabledAfter}`,
    `sentOrder=${expiredExecute.report.sentOrder}`,
  ].join("\n") + "\n",
);
