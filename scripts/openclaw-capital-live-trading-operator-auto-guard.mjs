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
  "openclaw-capital-live-trading-operator-auto-guard-latest.json",
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

async function main() {
  const approvalPath = path.resolve(argValue("--approval", DEFAULT_APPROVAL_PATH));
  const riskControlsPath = path.resolve(argValue("--risk-controls", DEFAULT_RISK_CONTROLS_PATH));
  const reportPath = path.resolve(argValue("--report", DEFAULT_REPORT_PATH));
  const execute = hasFlag("--execute");
  const writeState = hasFlag("--write-state");

  const statusResult = await runCapitalLiveTradingOperatorGate({
    action: "status",
    execute: false,
    writeState: false,
    approvalPath,
    riskControlsPath,
    reportPath,
  });

  const statusReport = statusResult.report;
  const enabled = statusReport?.riskControls?.enabledAfter === true;
  const expired = statusReport?.riskControls?.activationExpired === true;

  let guardAction = "status_only";
  let guardStatus = enabled ? "guard_live_enabled_monitoring" : "guard_live_disabled_idle";
  let applied = false;
  let enabledAfter = enabled;
  let nextSafeTask = "持續輪詢 guard。";
  let sentOrder = statusReport?.safety?.sentOrder === true;

  if (enabled && expired) {
    const reconcile = await runCapitalLiveTradingOperatorGate({
      action: "reconcile",
      execute,
      writeState,
      approvalPath,
      riskControlsPath,
      reportPath,
    });
    guardAction = "reconcile_expired_activation";
    guardStatus = execute ? "guard_expired_reconciled" : "guard_expired_pending_reconcile";
    applied = reconcile.report.applied === true;
    enabledAfter = reconcile.report?.riskControls?.enabledAfter === true;
    nextSafeTask = reconcile.report.nextSafeTask || "";
    sentOrder = reconcile.report?.safety?.sentOrder === true;
  } else if (enabled) {
    nextSafeTask = "live 已啟用且未到期；持續監控或人工回關。";
  } else {
    nextSafeTask = "目前為關閉狀態；如需啟用請跑 auto-activate。";
  }

  const wrapper = {
    schema: "openclaw.capital.live-trading-operator-auto-guard.v1",
    generatedAt: new Date().toISOString(),
    execute,
    approvalPath,
    riskControlsPath,
    guardAction,
    status: guardStatus,
    applied,
    enabledBefore: enabled,
    enabledAfter,
    activationExpired: expired,
    sentOrder,
    nextSafeTask,
  };

  if (writeState) {
    await writeJsonWithSha(reportPath, wrapper);
  }

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(wrapper, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital live trading auto-guard",
        `status=${wrapper.status}`,
        `guardAction=${wrapper.guardAction}`,
        `applied=${wrapper.applied}`,
        `enabledBefore=${wrapper.enabledBefore}`,
        `enabledAfter=${wrapper.enabledAfter}`,
        `activationExpired=${wrapper.activationExpired}`,
        `sentOrder=${wrapper.sentOrder}`,
        `nextSafeTask=${wrapper.nextSafeTask}`,
      ].join("\n") + "\n",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main();
}
