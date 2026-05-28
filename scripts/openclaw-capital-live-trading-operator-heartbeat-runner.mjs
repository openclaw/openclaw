import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalLiveTradingOperatorGate } from "./openclaw-capital-live-trading-operator-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const CAPITAL_ROOT =
  process.env.OPENCLAW_CAPITAL_HFT_SERVICE_ROOT || "D:\\群益及元大API\\CapitalHftService";

const DEFAULT_APPROVAL_PATH = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const DEFAULT_RISK_CONTROLS_PATH = path.join(CAPITAL_ROOT, "risk-controls.json");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-operator-heartbeat-runner-latest.json",
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

async function runHeartbeat(options = {}) {
  const approvalPath = path.resolve(options.approvalPath || DEFAULT_APPROVAL_PATH);
  const riskControlsPath = path.resolve(options.riskControlsPath || DEFAULT_RISK_CONTROLS_PATH);
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH);
  const execute = options.execute === true;
  const writeState = options.writeState === true;
  const intervalSecRaw = Number.parseInt(String(options.intervalSec ?? 60), 10);
  const intervalSec = Number.isFinite(intervalSecRaw) && intervalSecRaw > 0 ? intervalSecRaw : 60;

  const status = await runCapitalLiveTradingOperatorGate({
    action: "status",
    execute: false,
    writeState: false,
    approvalPath,
    riskControlsPath,
    reportPath,
  });

  let action = "status";
  let subStatus = "guard_live_disabled_idle";
  let applied = false;
  let enabledAfter = status.report?.riskControls?.enabledAfter ?? false;
  let activationExpired = status.report?.riskControls?.activationExpired ?? false;
  let sentOrder = status.report?.safety?.sentOrder ?? false;
  let nextSafeTask = status.report?.nextSafeTask || "";

  if (enabledAfter && activationExpired) {
    const reconcile = await runCapitalLiveTradingOperatorGate({
      action: "reconcile",
      execute,
      writeState,
      approvalPath,
      riskControlsPath,
      reportPath,
    });
    action = "reconcile_expired_activation";
    subStatus = execute ? "guard_expired_reconciled" : "guard_expired_pending_reconcile";
    applied = reconcile.report.applied ?? false;
    enabledAfter = reconcile.report?.riskControls?.enabledAfter ?? false;
    activationExpired = reconcile.report?.riskControls?.activationExpired ?? false;
    sentOrder = reconcile.report?.safety?.sentOrder ?? false;
    nextSafeTask = reconcile.report?.nextSafeTask || "";
  } else if (enabledAfter) {
    subStatus = "guard_live_enabled_monitoring";
    nextSafeTask = "live 已啟用且未到期；持續 heartbeat 監控。";
  } else {
    subStatus = "guard_live_disabled_idle";
    nextSafeTask = "live 目前為關閉狀態；維持 heartbeat 監控。";
  }

  const report = {
    schema: "openclaw.capital.live-trading-operator-heartbeat-runner.v1",
    generatedAt: new Date().toISOString(),
    execute,
    intervalSec,
    approvalPath,
    riskControlsPath,
    action,
    status: subStatus,
    applied,
    enabledAfter,
    activationExpired,
    sentOrder,
    nextSafeTask,
  };

  if (writeState) {
    await writeJsonWithSha(reportPath, report);
  }

  return { report, reportPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await runHeartbeat({
    approvalPath: argValue("--approval", DEFAULT_APPROVAL_PATH),
    riskControlsPath: argValue("--risk-controls", DEFAULT_RISK_CONTROLS_PATH),
    reportPath: argValue("--report", DEFAULT_REPORT_PATH),
    intervalSec: argValue("--interval-sec", "60"),
    execute: hasFlag("--execute"),
    writeState: hasFlag("--write-state"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital live trading heartbeat runner",
        `status=${result.report.status}`,
        `action=${result.report.action}`,
        `applied=${result.report.applied}`,
        `enabledAfter=${result.report.enabledAfter}`,
        `activationExpired=${result.report.activationExpired}`,
        `sentOrder=${result.report.sentOrder}`,
        `nextSafeTask=${result.report.nextSafeTask}`,
      ].join("\n") + "\n",
    );
  }
}

export { runHeartbeat };
