#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runOkxMarketSnapshotScheduler } from "./openclaw-okx-market-snapshot-scheduler.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["okx:market-snapshot:scheduler"],
  "node scripts/openclaw-okx-market-snapshot-scheduler.mjs --install --write-state --json",
);
assert.equal(
  scripts["okx:market-snapshot:scheduler:check"],
  "node scripts/check-openclaw-okx-market-snapshot-scheduler.mjs",
);

const { report } = await runOkxMarketSnapshotScheduler({ writeState: true });

assert.equal(report.schema, "openclaw.okx.market-snapshot-scheduler.v1");
assert.equal(report.provider, "okx");
assert.equal(report.status, "passed");
assert.equal(report.mode, "read_only_market_snapshot_scheduler");
assert.equal(report.schedule.jobId, "okx-market-snapshot-readonly-5m");
assert.equal(report.schedule.everyMs, 5 * 60 * 1000);
assert.equal(report.schedule.entrypoint, "pnpm okx:market-snapshot");
assert.equal(report.schedule.checkEntrypoint, "pnpm okx:market-snapshot:check");
assert.equal(report.safety.readOnly, true);
assert.equal(report.safety.publicMarketDataOnly, true);
assert.equal(report.safety.accountCredentialRequired, false);
assert.equal(report.safety.privateOrderQueryEnabled, false);
assert.equal(report.safety.orderPlacementEnabled, false);
assert.equal(report.safety.cancelOrderEnabled, false);
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeTradingEnabled, false);
assert.equal(report.safety.withdrawalEnabled, false);
assert.equal(report.safety.transferEnabled, false);
assert.equal(report.safety.submittedOrder, false);
assert.equal(report.safety.noOrderWrite, true);
assert.match(report.machineLine, /okxMarketSnapshotScheduler=pass/u);
assert.match(report.machineLine, /entrypoint=okx:market-snapshot/u);
assert.match(report.machineLine, /nextRunAt=\d{4}-\d{2}-\d{2}T/u);
assert.match(report.machineLine, /noOrderWrite=true/u);
assert.equal(report.blockers.length, 0);
for (const check of report.checks) {
  assert.equal(check.status, "pass", check.id);
}

process.stdout.write(
  [
    "OKX_MARKET_SNAPSHOT_SCHEDULER_CHECK=OK",
    `status=${report.status}`,
    `machineLine=${report.machineLine}`,
    `nextRunAt=${report.schedule.nextRunAt || "none"}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
