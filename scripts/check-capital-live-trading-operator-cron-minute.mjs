import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCronMinute } from "./openclaw-capital-live-trading-operator-cron-minute.mjs";

const repoRoot = process.cwd();
const sourceApprovalPath = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-operator-cron-minute-"));
const fixtureApprovalPath = path.join(tempDir, "capital-live-trading-approval.fixture.json");
const fixtureRiskExpiredPath = path.join(tempDir, "risk-controls.expired.fixture.json");
const fixtureReportPath = path.join(tempDir, "operator-cron-minute-report.fixture.json");
const fixtureGuardedReportPath = path.join(tempDir, "operator-cron-minute-guarded.fixture.json");
const fixtureHeartbeatReportPath = path.join(
  tempDir,
  "operator-cron-minute-heartbeat.fixture.json",
);

await fs.copyFile(sourceApprovalPath, fixtureApprovalPath);
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

const dryRun = await runCronMinute({
  approvalPath: fixtureApprovalPath,
  riskControlsPath: fixtureRiskExpiredPath,
  reportPath: fixtureReportPath,
  guardedReportPath: fixtureGuardedReportPath,
  heartbeatReportPath: fixtureHeartbeatReportPath,
  execute: false,
  writeState: true,
  skipSurfaceCheck: true,
  enableAutopilot: false,
});

assert.equal(dryRun.report.schema, "openclaw.capital.live-trading-operator-cron-minute.v1");
assert.equal(dryRun.report.cron.intervalSec, 60);
assert.equal(dryRun.report.execute, false);
assert.equal(dryRun.report.status, "guard_expired_pending_reconcile");
assert.equal(dryRun.report.enabledAfter, true);
assert.equal(dryRun.report.sentOrder, false);
await fs.access(fixtureReportPath);
await fs.access(`${fixtureReportPath}.sha256`);

const executeRun = await runCronMinute({
  approvalPath: fixtureApprovalPath,
  riskControlsPath: fixtureRiskExpiredPath,
  reportPath: fixtureReportPath,
  guardedReportPath: fixtureGuardedReportPath,
  heartbeatReportPath: fixtureHeartbeatReportPath,
  execute: true,
  writeState: true,
  skipSurfaceCheck: true,
  enableAutopilot: false,
});

assert.equal(executeRun.report.execute, true);
assert.equal(executeRun.report.status, "guard_expired_reconciled");
assert.equal(executeRun.report.applied, true);
assert.equal(executeRun.report.enabledAfter, false);
assert.equal(executeRun.report.sentOrder, false);

const riskAfter = JSON.parse(await fs.readFile(fixtureRiskExpiredPath, "utf8"));
assert.equal(riskAfter.allowLiveTrading, false);
assert.equal(riskAfter.writeBrokerOrders, false);
assert.equal(riskAfter.liveDeactivation.enabled, true);
assert.equal(riskAfter.liveDeactivation.reason, "activation_ttl_expired");

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_OPERATOR_CRON_MINUTE_CHECK=OK",
    `dryRun=${dryRun.report.status}`,
    `execute=${executeRun.report.status}`,
    `enabledAfter=${executeRun.report.enabledAfter}`,
    `sentOrder=${executeRun.report.sentOrder}`,
  ].join("\n") + "\n",
);
