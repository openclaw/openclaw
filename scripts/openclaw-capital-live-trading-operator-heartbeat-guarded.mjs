import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHeartbeat } from "./openclaw-capital-live-trading-operator-heartbeat-runner.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-operator-heartbeat-guarded-latest.json",
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

function runSurfaceCheck() {
  const scriptPath = path.join(
    repoRoot,
    "scripts",
    "check-capital-live-trading-operator-surface.mjs",
  );
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    statusCode: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

async function runGuarded(options = {}) {
  const execute = options.execute === true;
  const writeState = options.writeState === true;
  const skipSurfaceCheck = options.skipSurfaceCheck === true;
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH);

  const surface = skipSurfaceCheck
    ? {
        ok: true,
        skipped: true,
        statusCode: 0,
        stdout: "surface-check skipped by flag",
        stderr: "",
      }
    : {
        ...runSurfaceCheck(),
        skipped: false,
      };

  if (!surface.ok) {
    const report = {
      schema: "openclaw.capital.live-trading-operator-heartbeat-guarded.v1",
      generatedAt: new Date().toISOString(),
      execute,
      status: "guard_blocked_by_surface_check",
      applied: false,
      enabledAfter: false,
      sentOrder: false,
      surfaceCheck: {
        ok: false,
        skipped: false,
        statusCode: surface.statusCode,
      },
      nextSafeTask: "先修復 operator surface 檢查，再執行 heartbeat guarded。",
    };
    if (writeState) {
      await writeJsonWithSha(reportPath, report);
    }
    return { report, reportPath };
  }

  const heartbeat = await runHeartbeat({
    approvalPath: options.approvalPath,
    riskControlsPath: options.riskControlsPath,
    reportPath: options.heartbeatReportPath,
    intervalSec: options.intervalSec,
    execute,
    writeState,
  });

  const report = {
    schema: "openclaw.capital.live-trading-operator-heartbeat-guarded.v1",
    generatedAt: new Date().toISOString(),
    execute,
    status: heartbeat.report.status,
    action: heartbeat.report.action,
    applied: heartbeat.report.applied === true,
    enabledAfter: heartbeat.report.enabledAfter === true,
    activationExpired: heartbeat.report.activationExpired === true,
    sentOrder: heartbeat.report.sentOrder === true,
    surfaceCheck: {
      ok: true,
      skipped: skipSurfaceCheck,
      statusCode: 0,
    },
    nextSafeTask: heartbeat.report.nextSafeTask || "",
  };

  if (writeState) {
    await writeJsonWithSha(reportPath, report);
  }

  return { report, reportPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await runGuarded({
    approvalPath: argValue("--approval", ""),
    riskControlsPath: argValue("--risk-controls", ""),
    reportPath: argValue("--report", DEFAULT_REPORT_PATH),
    heartbeatReportPath: argValue("--heartbeat-report", ""),
    intervalSec: argValue("--interval-sec", "60"),
    execute: hasFlag("--execute"),
    writeState: hasFlag("--write-state"),
    skipSurfaceCheck: hasFlag("--skip-surface-check"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital live trading heartbeat guarded",
        `status=${result.report.status}`,
        `action=${result.report.action || "N/A"}`,
        `applied=${result.report.applied}`,
        `enabledAfter=${result.report.enabledAfter}`,
        `surfaceCheckOk=${result.report.surfaceCheck?.ok === true}`,
        `surfaceCheckSkipped=${result.report.surfaceCheck?.skipped === true}`,
        `sentOrder=${result.report.sentOrder}`,
        `nextSafeTask=${result.report.nextSafeTask}`,
      ].join("\n") + "\n",
    );
  }
}

export { runGuarded };
