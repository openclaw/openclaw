import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalLiveTradingAutopilotCycle } from "./openclaw-capital-live-trading-autopilot-cycle.mjs";
import { runGuarded } from "./openclaw-capital-live-trading-operator-heartbeat-guarded.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-operator-cron-minute-latest.json",
);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

async function runCronMinute(options = {}) {
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH);
  const execute = options.execute !== false;
  const writeState = options.writeState !== false;
  const skipSurfaceCheck = options.skipSurfaceCheck === true;
  const enableAutopilot = options.enableAutopilot !== false;

  const guarded = await runGuarded({
    approvalPath: options.approvalPath,
    riskControlsPath: options.riskControlsPath,
    reportPath: options.guardedReportPath,
    heartbeatReportPath: options.heartbeatReportPath,
    intervalSec: 60,
    execute,
    writeState,
    skipSurfaceCheck,
  });
  const autopilot = enableAutopilot
    ? await runCapitalLiveTradingAutopilotCycle({
        repoRoot,
        execute,
        writeState,
      })
    : null;
  const sentOrder = guarded.report.sentOrder === true || autopilot?.safety?.sentOrder === true;

  const report = {
    schema: "openclaw.capital.live-trading-operator-cron-minute.v1",
    generatedAt: new Date().toISOString(),
    cron: {
      intervalSec: 60,
      command: "pnpm capital:live-trading:operator:cron:minute",
    },
    execute,
    surfaceCheckSkipped: skipSurfaceCheck,
    status: guarded.report.status,
    action: autopilot?.action || guarded.report.action || "",
    applied: guarded.report.applied === true,
    enabledAfter: guarded.report.enabledAfter === true,
    sentOrder,
    nextSafeTask: autopilot?.nextSafeTask || guarded.report.nextSafeTask || "",
    autopilot: enableAutopilot
      ? {
          status: autopilot?.status || "unknown",
          action: autopilot?.action || "",
          majorEvent: autopilot?.majorEvent === true,
          majorEventLock: autopilot?.majorEventLock === true,
          quoteFresh: autopilot?.quoteFresh === true,
          shouldAutoTrade: autopilot?.shouldAutoTrade === true,
          sentOrder: autopilot?.safety?.sentOrder === true,
          noLiveOrderSent: autopilot?.safety?.noLiveOrderSent === true,
        }
      : {
          status: "disabled",
          action: "disabled_for_fixture_or_manual_override",
          majorEvent: false,
          majorEventLock: false,
          quoteFresh: false,
          shouldAutoTrade: false,
          sentOrder: false,
          noLiveOrderSent: true,
        },
  };

  if (writeState) {
    await writeJsonWithSha(reportPath, report);
  }

  return { report, reportPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await runCronMinute({
    approvalPath: argValue("--approval", ""),
    riskControlsPath: argValue("--risk-controls", ""),
    reportPath: argValue("--report", DEFAULT_REPORT_PATH),
    guardedReportPath: argValue("--guarded-report", ""),
    heartbeatReportPath: argValue("--heartbeat-report", ""),
    execute: !hasFlag("--dry-run"),
    writeState: !hasFlag("--no-write-state"),
    skipSurfaceCheck: hasFlag("--skip-surface-check"),
    enableAutopilot: !hasFlag("--skip-autopilot"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital live trading cron-minute runner",
        `status=${result.report.status}`,
        `action=${result.report.action || "N/A"}`,
        `applied=${result.report.applied}`,
        `enabledAfter=${result.report.enabledAfter}`,
        `sentOrder=${result.report.sentOrder}`,
        `nextSafeTask=${result.report.nextSafeTask}`,
      ].join("\n") + "\n",
    );
  }
}

export { runCronMinute };
