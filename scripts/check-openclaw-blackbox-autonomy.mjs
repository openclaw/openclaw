#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBlackboxAutonomyTick } from "./openclaw-blackbox-autonomy-tick.mjs";
import { runBlackboxSyncBridge } from "./openclaw-blackbox-sync-bridge.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRootDefault = path.resolve(path.dirname(currentFile), "..");
const CONFIG_REL = "config/openclaw-blackbox-autonomy.json";
const AUTONOMY_REPORT_REL = "reports/hermes-agent/state/openclaw-blackbox-autonomy-latest.json";
const SYNC_REPORT_REL = "reports/hermes-agent/state/openclaw-blackbox-sync-latest.json";

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

async function assertFile(filePath, label) {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`${label} is not a file`);
    }
  } catch (error) {
    throw new Error(`${label} missing: ${filePath}`, { cause: error });
  }
}

function assertCondition(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function validateAutonomyReport(report) {
  const requiredFields = [
    "cycleId",
    "generatedCandidates",
    "accepted",
    "rejected",
    "repairActions",
    "hardStop",
    "rollbackPointer",
    "nextSafeTask",
    "machineLine",
  ];
  for (const field of requiredFields) {
    assertCondition(
      report && Object.prototype.hasOwnProperty.call(report, field),
      `missing ${field}`,
    );
  }
  assertCondition(typeof report.machineLine === "string", "machineLine must be string");
  assertCondition(
    report.machineLine.includes("noOrderWrite=true"),
    "machineLine must include noOrderWrite=true",
  );
  assertCondition(
    report.machineLine.includes("allowLiveTrading=false"),
    "machineLine must include allowLiveTrading=false",
  );
  assertCondition(report?.safety?.noOrderWrite === true, "safety.noOrderWrite must be true");
  assertCondition(
    report?.safety?.allowLiveTrading === false,
    "safety.allowLiveTrading must be false",
  );
}

function validateSyncReport(report) {
  const requiredFields = [
    "upstreamVersion",
    "downstreamVersion",
    "syncStatus",
    "conflictResolution",
    "lastAckAt",
    "machineLine",
  ];
  for (const field of requiredFields) {
    assertCondition(
      report && Object.prototype.hasOwnProperty.call(report, field),
      `missing ${field}`,
    );
  }
  assertCondition(typeof report.machineLine === "string", "sync machineLine must be string");
  assertCondition(
    report.machineLine.includes("noOrderWrite=true"),
    "sync machineLine must include noOrderWrite=true",
  );
}

function assertScriptContains(scripts, key, token) {
  const value = scripts?.[key];
  assertCondition(typeof value === "string", `package.json missing script ${key}`);
  assertCondition(value.includes(token), `package.json script ${key} must include ${token}`);
}

async function main() {
  const repoRoot = repoRootDefault;
  const configPath = path.join(repoRoot, CONFIG_REL);
  const autonomyReportPath = path.join(repoRoot, AUTONOMY_REPORT_REL);
  const syncReportPath = path.join(repoRoot, SYNC_REPORT_REL);
  const tickPath = path.join(repoRoot, "scripts", "openclaw-blackbox-autonomy-tick.mjs");
  const syncPath = path.join(repoRoot, "scripts", "openclaw-blackbox-sync-bridge.mjs");

  await assertFile(configPath, "blackbox config");
  await assertFile(tickPath, "blackbox autonomy tick script");
  await assertFile(syncPath, "blackbox sync bridge script");
  await assertFile(
    path.join(repoRoot, "scripts", "check-openclaw-blackbox-autonomy.mjs"),
    "blackbox check script",
  );

  const config = await readJson(configPath);
  assertCondition(
    config.schema === "openclaw.blackbox.autonomy.config.v1",
    "config schema mismatch",
  );
  assertCondition(
    config?.safety?.allowLiveTrading === false,
    "config safety.allowLiveTrading must be false",
  );
  assertCondition(config?.safety?.noOrderWrite === true, "config safety.noOrderWrite must be true");

  const packageJson = await readJson(path.join(repoRoot, "package.json"));
  assertScriptContains(packageJson.scripts, "blackbox:tick", "openclaw-blackbox-autonomy-tick.mjs");
  assertScriptContains(packageJson.scripts, "blackbox:sync", "openclaw-blackbox-sync-bridge.mjs");
  assertScriptContains(
    packageJson.scripts,
    "blackbox:daemon",
    "openclaw-controlled-task-runner-watch.mjs --task blackbox_autonomy_tick --interval-ms 60000",
  );
  assertScriptContains(
    packageJson.scripts,
    "blackbox:check",
    "check-openclaw-blackbox-autonomy.mjs",
  );

  await runBlackboxAutonomyTick({
    repoRoot,
    configPath,
    reportPath: autonomyReportPath,
    writeState: true,
    skipDmadExec: true,
  });
  await runBlackboxSyncBridge({
    repoRoot,
    configPath,
    upstreamPath: autonomyReportPath,
    reportPath: syncReportPath,
    writeState: true,
  });

  const autonomyReport = await readJson(autonomyReportPath);
  const syncReport = await readJson(syncReportPath);
  validateAutonomyReport(autonomyReport);
  validateSyncReport(syncReport);

  process.stdout.write("OPENCLAW_BLACKBOX_AUTONOMY_CHECK=OK\n");
  process.stdout.write(`AUTONOMY_MACHINE_LINE=${autonomyReport.machineLine}\n`);
  process.stdout.write(`SYNC_MACHINE_LINE=${syncReport.machineLine}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main().catch((error) => {
    process.stderr.write(
      `openclaw blackbox autonomy check failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
