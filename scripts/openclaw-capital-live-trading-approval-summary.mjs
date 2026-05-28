import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncCapitalLiveTradingApproval } from "./openclaw-capital-live-trading-approval-sync.mjs";
import { runCapitalLiveTradingPromotionGate } from "./openclaw-capital-live-trading-promotion-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_APPROVAL_PATH = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const DEFAULT_HFT_STATUS_PATH = "D:\\群益及元大API\\CapitalHftService\\hft_service_status.json";
const DEFAULT_RISK_CONTROLS_PATH = "D:\\群益及元大API\\CapitalHftService\\risk-controls.json";
const DEFAULT_JSON_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-approval-summary-latest.json",
);
const DEFAULT_MD_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-approval-summary-latest.md",
);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function readJsonOptional(filePath) {
  try {
    return await readJson(filePath);
  } catch {
    return null;
  }
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

function yesNo(value) {
  return value === true ? "true" : "false";
}

function filled(value) {
  return typeof value === "string" && value.trim() ? "已填" : "未填";
}

function approvalStatus(approval, liveGate) {
  if (approval?.riskLiveTradingEnabled === true && approval?.riskWriteTradingEnabled === true) {
    return "live_enabled_manual_window";
  }
  if (approval?.humanApproved === true && liveGate?.readyForManualReview === true) {
    return "manual_review_required";
  }
  return "blocked_pending_manual_approval";
}

function buildTelegramSummary(approval, liveGate, riskControls) {
  const liveEnabled = riskControls?.allowLiveTrading === true;
  const writeEnabled = riskControls?.writeBrokerOrders === true;
  const liveStateText = liveEnabled && writeEnabled ? "已開啟" : "封鎖";
  const liveWriteStateText = liveEnabled && writeEnabled ? "ON" : "OFF";
  const accountCount = Array.isArray(approval?.accountAllowlist)
    ? approval.accountAllowlist.length
    : 0;
  const blockers =
    liveEnabled && writeEnabled
      ? "none"
      : Array.isArray(liveGate?.blockers) && liveGate.blockers.length > 0
        ? liveGate.blockers.join(",")
        : "none";
  return [
    `群益真單=${liveStateText}`,
    `humanApproved=${yesNo(approval?.humanApproved)}`,
    `accountAllowlist=${accountCount}`,
    `killSwitch=${yesNo(approval?.killSwitch)}`,
    `rollbackPlan=${filled(approval?.rollbackPlan)}`,
    `live/write/order=${liveWriteStateText}`,
    `blockers=${blockers}`,
  ].join("；");
}

function buildMarkdown(report) {
  return [
    "# Capital Live Trading Approval Summary",
    "",
    `- status: ${report.status}`,
    `- telegram: ${report.telegram_summary_oneline_zh_tw}`,
    `- liveTradingEnabled: ${report.safety.liveTradingEnabled}`,
    `- writeTradingEnabled: ${report.safety.writeTradingEnabled}`,
    `- sentOrder: ${report.safety.sentOrder}`,
    `- nextSafeTask: ${report.nextSafeTask}`,
    "",
  ].join("\n");
}

export async function buildCapitalLiveTradingApprovalSummary(options = {}) {
  const approvalPath = path.resolve(options.approvalPath || DEFAULT_APPROVAL_PATH);
  const riskControlsPath = path.resolve(options.riskControlsPath || DEFAULT_RISK_CONTROLS_PATH);
  const syncResult =
    options.syncAccountAllowlist === false
      ? null
      : await syncCapitalLiveTradingApproval({
          approvalPath,
          hftStatusPath: options.hftStatusPath || DEFAULT_HFT_STATUS_PATH,
          writeState: options.writeGateState === true,
        });
  const approval = syncResult?.approval ?? (await readJson(approvalPath));
  const riskControls = await readJsonOptional(riskControlsPath);
  approval.riskLiveTradingEnabled = riskControls?.allowLiveTrading === true;
  approval.riskWriteTradingEnabled = riskControls?.writeBrokerOrders === true;
  const { report: liveGate } = await runCapitalLiveTradingPromotionGate({
    approvalPath,
    writeState: options.writeGateState === true,
  });
  const generatedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const status = approvalStatus(approval, liveGate);
  const liveTradingEnabled = riskControls?.allowLiveTrading === true;
  const writeTradingEnabled = riskControls?.writeBrokerOrders === true;

  return {
    schema: "openclaw.capital.live-trading-approval-summary.v1",
    generatedAt,
    provider: "capital",
    status,
    language: "zh-TW",
    telegram_summary_oneline_zh_tw: buildTelegramSummary(approval, liveGate, riskControls),
    approval: {
      schema: approval.schema ?? "",
      approvalStatus: approval.approvalStatus ?? "",
      humanApproved: approval.humanApproved === true,
      accountAllowlistCount: Array.isArray(approval.accountAllowlist)
        ? approval.accountAllowlist.length
        : 0,
      accountAllowlistSource: approval.accountAllowlistSource ?? "",
      autoDetectedAccountCount: Number(approval.autoDetectedAccountCount ?? 0),
      manualAccountReviewRequired: approval.manualAccountReviewRequired === true,
      killSwitch: approval.killSwitch === true,
      rollbackPlanFilled:
        typeof approval.rollbackPlan === "string" && approval.rollbackPlan.trim().length > 0,
      manualOperatorConfirmed: approval.reviewChecklist?.manualOperatorConfirmed === true,
      telegramNotificationVerified: approval.reviewChecklist?.telegramNotificationVerified === true,
    },
    liveGate: {
      status: liveGate.status,
      blockerCode: liveGate.blockerCode,
      blockers: Array.isArray(liveGate.blockers) ? liveGate.blockers : [],
      readyForManualReview: liveGate.readyForManualReview === true,
    },
    safety: {
      liveTradingEnabled,
      writeTradingEnabled,
      externalWriteEnabled: writeTradingEnabled,
      brokerOrderPathEnabled: writeTradingEnabled,
      loginAttempted: false,
      sentOrder: false,
      readOnlyReportOnly: !(liveTradingEnabled && writeTradingEnabled),
    },
    nextSafeTask:
      status === "live_enabled_manual_window"
        ? "真單視窗已開啟；請持續監控策略/風險，並在視窗到期前主動執行 deactivate 或 reconcile。"
        : status === "manual_review_required"
          ? "人工審查 live promotion gate；仍不可由自動化啟用 live API 或下單。"
          : "帳號 allowlist 已由服務狀態自動同步；人工仍需確認 humanApproved、killSwitch、rollbackPlan，重跑 capital-hft:live-trading:approval:summary:check。",
  };
}

async function main() {
  const outputJsonPath = path.resolve(argValue("--output", DEFAULT_JSON_PATH));
  const outputMdPath = path.resolve(argValue("--markdown", DEFAULT_MD_PATH));
  const report = await buildCapitalLiveTradingApprovalSummary({
    approvalPath: argValue("--approval", DEFAULT_APPROVAL_PATH),
    hftStatusPath: argValue("--hft-status", DEFAULT_HFT_STATUS_PATH),
    writeGateState: hasFlag("--write-state"),
  });
  if (hasFlag("--write-state")) {
    await writeText(outputJsonPath, `${JSON.stringify(report, null, 2)}\n`);
    await writeText(outputMdPath, buildMarkdown(report));
  }
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report.telegram_summary_oneline_zh_tw}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital live trading approval summary failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
