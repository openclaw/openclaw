#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_DIR_REL = "reports/hermes-agent/state";
const SUMMARY_FILE_NAME = "openclaw-controlled-task-runner-telegram-latest.json";
const REPORT_LATEST_FILE_NAME = "openclaw-controlled-task-runner-telegram-publish-latest.json";
const REPORT_SCHEMA = "openclaw.controlled-task-runner.telegram-publish.report.v1";
const TELEGRAM_TRADING_SHORTCUTS_REPORT_NAME = "openclaw-telegram-trading-shortcuts-latest.json";
const TRADINGAGENTS_SUMMARY_REPORT_NAME = "openclaw-tradingagents-summary-latest.json";
const RETRY_MAX_ATTEMPTS_ENV = "OPENCLAW_TELEGRAM_PUBLISH_MAX_ATTEMPTS";
const RETRY_BASE_DELAY_MS_ENV = "OPENCLAW_TELEGRAM_PUBLISH_RETRY_BASE_DELAY_MS";
const TELEGRAM_TARGET_ENV = "OPENCLAW_TELEGRAM_STATUS_TARGET";
const TELEGRAM_SENT_MESSAGES_REL =
  ".openclaw/agents/main/sessions/sessions.json.telegram-sent-messages.json";

function parseArgs(argv) {
  const options = {
    dryRun: true,
    help: false,
    summaryPath: "",
    reportPath: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--execute") {
      options.dryRun = false;
      continue;
    }
    if (arg === "--summary") {
      options.summaryPath = argv[++index] ?? "";
      continue;
    }
    if (arg.startsWith("--summary=")) {
      options.summaryPath = arg.slice("--summary=".length);
      continue;
    }
    if (arg === "--report") {
      options.reportPath = argv[++index] ?? "";
      continue;
    }
    if (arg.startsWith("--report=")) {
      options.reportPath = arg.slice("--report=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      return options;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/openclaw-controlled-task-runner-telegram-publish.mjs --dry-run",
    "  node scripts/openclaw-controlled-task-runner-telegram-publish.mjs --execute",
    "  node scripts/openclaw-controlled-task-runner-telegram-publish.mjs --dry-run --summary reports/hermes-agent/state/custom-summary.json --report reports/hermes-agent/state/custom-publish.json",
    "",
    "Environment:",
    "  OPENCLAW_TELEGRAM_STATUS_TARGET   Telegram target/chat id (optional if sent-messages history exists)",
    "  OPENCLAW_TELEGRAM_STATUS_THREAD_ID Optional telegram topic thread id",
    "  OPENCLAW_TELEGRAM_PUBLISH_MAX_ATTEMPTS Optional retry attempts (default 2, range 1-5)",
    "  OPENCLAW_TELEGRAM_PUBLISH_RETRY_BASE_DELAY_MS Optional retry base delay in ms (default 1500, range 100-30000)",
  ].join("\n");
}

async function readJson(filePath) {
  const content = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  return JSON.parse(content);
}

async function readOptionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") {
      return null;
    }
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function parsePositiveIntegerEnv(envName, fallback, min, max) {
  const raw = process.env[envName];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return clampNumber(parsed, min, max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNodeOpenClaw(args, repoRoot) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdoutChunks = [];
    const stderrChunks = [];
    let child;
    try {
      child = spawn(process.execPath, ["openclaw.mjs", ...args], {
        cwd: repoRoot,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode =
        typeof error === "object" && error !== null && typeof error.code === "string"
          ? error.code
          : "SPAWN_THROWN";
      resolve({
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: stdoutChunks.join(""),
        stderr: `${stderrChunks.join("")}\n${message}`.trim(),
        errorCode,
      });
      return;
    }

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      stdoutChunks.push(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrChunks.push(String(chunk));
    });
    child.once("error", (error) => {
      resolve({
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: stdoutChunks.join(""),
        stderr: `${stderrChunks.join("")}\n${error.message}`.trim(),
        errorCode:
          typeof error === "object" && error !== null && typeof error.code === "string"
            ? error.code
            : "SPAWN_ERROR",
      });
    });
    child.once("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        durationMs: Date.now() - startedAt,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        errorCode: code === 0 ? "OK" : "TASK_NON_ZERO_EXIT",
      });
    });
  });
}

function normalizeTextValue(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function countTokenOccurrences(value, token) {
  if (typeof value !== "string" || token.length === 0) {
    return 0;
  }
  return value.split(token).length - 1;
}

function countPatternOccurrences(value, pattern) {
  if (typeof value !== "string") {
    return 0;
  }
  return Array.from(value.matchAll(pattern)).length;
}

function hasOperationalExecuteRequiredToken(value) {
  return typeof value === "string" && /executeRequired=(?:true|false)(?![\w=])/.test(value);
}

function hasOperationalNoOrderWriteToken(value) {
  return typeof value === "string" && /noOrderWrite=true(?![\w=])/.test(value);
}

function buildMessageTokenCounts(message) {
  return {
    shortcutChecks: countTokenOccurrences(message, "快捷檢查=shortcutChecks="),
    tradingAgents: countTokenOccurrences(message, "TradingAgents=tradingAgents="),
    receiptPrompt: countTokenOccurrences(message, "回關收據命令=receiptPrompt="),
    localExecutorDispatch: countTokenOccurrences(
      message,
      "本地執行器=capitalLocalExecutorDispatch=",
    ),
    positionSnapshot: countTokenOccurrences(message, "倉位快照=capitalVerifiedPositionSnapshot="),
    okxRefresh: countTokenOccurrences(message, "OKX刷新=okxCurrentReadinessRefresh="),
    okxHeartbeat: countTokenOccurrences(message, "OKX心跳=okxHeartbeatRefresh="),
    okxContract: countTokenOccurrences(message, "OKX合約=okxSchedulerNoOrderContract="),
    executeRequired: countPatternOccurrences(message, /executeRequired=(?:true|false)(?![\w=])/g),
    noOrderWrite: countPatternOccurrences(message, /noOrderWrite=true(?![\w=])/g),
    nextCommand: countTokenOccurrences(message, "下一步指令=nextCommandShortRow="),
    dmadGate:
      countTokenOccurrences(message, "DMAD=timeout-smoke:gate:ultra:verify:ultra:full") +
      countTokenOccurrences(message, "dmadGate=timeout-smoke:gate:ultra:verify:ultra:full"),
  };
}

function buildMessageTokenCountsSummaryZhTw(counts) {
  return [
    "messageTokenCounts",
    `快捷檢查=${counts.shortcutChecks}`,
    `TradingAgents=${counts.tradingAgents}`,
    `回關收據命令=${counts.receiptPrompt}`,
    `本地執行器=${counts.localExecutorDispatch}`,
    `倉位快照=${counts.positionSnapshot}`,
    `OKX刷新=${counts.okxRefresh}`,
    `OKX心跳=${counts.okxHeartbeat}`,
    `OKX合約=${counts.okxContract}`,
    `executeRequired=${counts.executeRequired}`,
    `noOrderWrite=true=${counts.noOrderWrite}`,
    `下一步指令=${counts.nextCommand}`,
    `DMAD=${counts.dmadGate}`,
  ].join(" ");
}

function normalizeBooleanToken(value, fallback = false) {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return fallback ? "true" : "false";
}

function buildOkxHeartbeatRefreshLine(summary) {
  const closure = summary?.okxCurrentReadinessHeartbeatOperationClosure ?? null;
  if (!closure || typeof closure !== "object") {
    return "";
  }
  const callback =
    normalizeTextValue(closure.telegramCallback) ||
    (Array.isArray(closure.callbackPair) ? normalizeTextValue(closure.callbackPair[0]) : "");
  const refreshCommand =
    normalizeTextValue(closure.refreshCommand) || "pnpm okx:current-readiness:refresh";
  const machineLine = normalizeTextValue(closure.machineLine);
  const schedulerNextRunAt =
    normalizeTextValue(closure.schedulerNextRunAt) ||
    machineLine.match(/\bschedulerNextRunAt=([^\s｜|]+)/u)?.[1] ||
    "unavailable";
  const executeRequired = normalizeBooleanToken(closure.executeRequired, false);
  const noOrderWrite = normalizeBooleanToken(
    closure.noOrderWrite === true || machineLine.includes("noOrderWrite=true"),
    false,
  );
  if (!callback && !machineLine) {
    return "";
  }
  return [
    `okxHeartbeatRefresh=${callback || refreshCommand}`,
    `command=${refreshCommand}`,
    `schedulerNextRunAt=${schedulerNextRunAt}`,
    `executeRequired=${executeRequired}`,
    `noOrderWrite=${noOrderWrite}`,
  ].join(" ");
}

function buildOkxSchedulerNoOrderContractLine(summary) {
  const closure = summary?.okxSchedulerNoOrderContractProbeClosure ?? null;
  if (!closure || typeof closure !== "object") {
    return "";
  }
  const machineLine = normalizeTextValue(closure.machineLine);
  if (!machineLine) {
    return "";
  }
  return machineLine.replace(/\bnoOrderWrite=true\b/u, "noOrderWriteVerified=true");
}

function buildTradingAgentsLine(tradingAgentsReport) {
  if (!tradingAgentsReport || typeof tradingAgentsReport !== "object") {
    return "";
  }
  const runtime =
    tradingAgentsReport.runtime && typeof tradingAgentsReport.runtime === "object"
      ? tradingAgentsReport.runtime
      : {};
  const status = normalizeTextValue(tradingAgentsReport.status) || "missing";
  const provider = normalizeTextValue(runtime.provider) || "unknown";
  const mode = normalizeTextValue(runtime.mode) || "unknown";
  const canAnalyze = normalizeBooleanToken(tradingAgentsReport.canAnalyzeNow === true, false);
  const official = normalizeBooleanToken(
    tradingAgentsReport.canUseOfficialTradingAgents === true,
    false,
  );
  const noOrderWriteVerified = normalizeBooleanToken(runtime.noOrderWrite === true, false);
  const noLiveOrderSent = normalizeBooleanToken(
    tradingAgentsReport.no_live_order_sent === true,
    false,
  );
  const brokerWriteAttempted = normalizeBooleanToken(
    tradingAgentsReport.brokerWriteAttempted === true || runtime.brokerWriteAttempted === true,
    false,
  );
  const nextSafeTask =
    normalizeTextValue(tradingAgentsReport.nextSafeTask) ||
    "run pnpm tradingagents:install only after explicit human approval";
  return [
    `tradingAgents=${status}`,
    `provider=${provider}`,
    `mode=${mode}`,
    `canAnalyze=${canAnalyze}`,
    `official=${official}`,
    `noOrderWriteVerified=${noOrderWriteVerified}`,
    `noLiveOrderSent=${noLiveOrderSent}`,
    `brokerWriteAttempted=${brokerWriteAttempted}`,
    `next=${nextSafeTask}`,
  ].join(" ");
}

function buildCapitalOperatorPacketLine(summary) {
  const closure = summary?.capitalOperatorPacketClosure ?? null;
  if (!closure || typeof closure !== "object") {
    return "";
  }
  const machineLine = normalizeTextValue(closure.machineLine);
  const packetStatus =
    machineLine.match(/\bcapitalOperatorPacket=([^\s｜|]+)/u)?.[1] ||
    normalizeTextValue(closure.packetStatus) ||
    normalizeTextValue(closure.status) ||
    "missing";
  const readinessStatus =
    normalizeTextValue(closure.readinessStatus) ||
    machineLine.match(/\breadiness=([^\s｜|]+)/u)?.[1] ||
    "unknown";
  const adapterAckStatus =
    normalizeTextValue(closure.adapterAckStatus) ||
    machineLine.match(/\badapterAck=([^\s｜|]+)/u)?.[1] ||
    "unknown";
  const dispatchPolicy =
    normalizeTextValue(closure.dispatchPolicy) ||
    machineLine.match(/\bdispatch(?:Policy)?=([^\s｜|]+)/u)?.[1] ||
    "unknown";
  const operatorCanExecute = normalizeBooleanToken(
    closure.operatorCanExecute === true || machineLine.includes("operatorCanExecute=true"),
    false,
  );
  const sentOrder = normalizeBooleanToken(
    closure.sentOrder === true || machineLine.includes("sentOrder=true"),
    false,
  );
  const blockerCount = Number.isFinite(Number(closure.blockerCount))
    ? String(Number(closure.blockerCount))
    : String(Array.isArray(closure.blockers) ? closure.blockers.length : 0);
  return [
    `capitalOperatorPacket=${packetStatus}`,
    `operatorCanExecute=${operatorCanExecute}`,
    `readiness=${readinessStatus}`,
    `adapterAck=${adapterAckStatus}`,
    `dispatchPolicy=${dispatchPolicy}`,
    `sentOrder=${sentOrder}`,
    `blockers=${blockerCount}`,
  ].join(" ");
}

function buildCapitalLocalExecutorDispatchLine(summary) {
  const closure = summary?.capitalLocalExecutorDispatchClosure ?? null;
  if (!closure || typeof closure !== "object") {
    return "";
  }
  const machineLine = normalizeTextValue(closure.machineLine);
  const dispatchStatus =
    machineLine.match(/\bcapitalLocalExecutorDispatch=([^\s｜|]+)/u)?.[1] ||
    normalizeTextValue(closure.dispatchStatus) ||
    normalizeTextValue(closure.status) ||
    "missing";
  const dispatchPolicy =
    normalizeTextValue(closure.dispatchPolicy) ||
    machineLine.match(/\bdispatchPolicy=([^\s｜|]+)/u)?.[1] ||
    "unknown";
  const operatorCanExecute = normalizeBooleanToken(
    closure.operatorCanExecute === true || machineLine.includes("operatorCanExecute=true"),
    false,
  );
  const executorArmed = normalizeBooleanToken(
    closure.executorArmed === true || machineLine.includes("executorArmed=true"),
    false,
  );
  const sentOrder = normalizeBooleanToken(
    closure.sentOrder === true || machineLine.includes("sentOrder=true"),
    false,
  );
  const noOrderWrite = normalizeBooleanToken(
    closure.noOrderWrite === true || machineLine.includes("noOrderWrite=true"),
    false,
  );
  const blockerCount = Number.isFinite(Number(closure.blockerCount))
    ? String(Number(closure.blockerCount))
    : String(Array.isArray(closure.blockers) ? closure.blockers.length : 0);
  return [
    `capitalLocalExecutorDispatch=${dispatchStatus}`,
    `operatorCanExecute=${operatorCanExecute}`,
    `executorArmed=${executorArmed}`,
    `dispatchPolicy=${dispatchPolicy}`,
    `sentOrder=${sentOrder}`,
    `blockers=${blockerCount}`,
    `noOrderWrite=${noOrderWrite}`,
  ].join(" ");
}

function buildCapitalVerifiedPositionSnapshotLine(summary) {
  const closure = summary?.capitalVerifiedPositionSnapshotClosure ?? null;
  if (!closure || typeof closure !== "object") {
    return "";
  }
  const machineLine = normalizeTextValue(closure.machineLine);
  const status =
    machineLine.match(/\bcapitalVerifiedPositionSnapshot=([^\s｜|;]+)/u)?.[1] ||
    normalizeTextValue(closure.status) ||
    "missing";
  const decisionStatus =
    normalizeTextValue(closure.decisionStatus) ||
    machineLine.match(/\bdecision=([^\s｜|;]+)/u)?.[1] ||
    "unknown";
  const freshnessStatus =
    normalizeTextValue(closure.freshnessStatus) ||
    machineLine.match(/\bfreshness=([^\s｜|;]+)/u)?.[1] ||
    "unknown";
  const nextCommand =
    normalizeTextValue(closure.nextCommand) || "pnpm capital:trade:direct:status:check";
  const noOrderWrite = normalizeBooleanToken(
    closure.noOrderWrite === true || machineLine.includes("noOrderWrite=true"),
    false,
  );
  return [
    `capitalVerifiedPositionSnapshot=${status}`,
    `decision=${decisionStatus}`,
    `freshness=${freshnessStatus}`,
    "next=sc:tr:directpos",
    `command=${nextCommand}`,
    `noOrderWrite=${noOrderWrite}`,
  ].join(" ");
}

function buildTradingShortcutsMessageSuffix(
  tradingShortcutsReport,
  existingMessage = "",
  tradingAgentsReport = null,
) {
  const summary = tradingShortcutsReport?.summary ?? null;
  const existing = normalizeTextValue(existingMessage);
  const tradingAgentsLine = buildTradingAgentsLine(tradingAgentsReport);
  const machineLine = normalizeTextValue(summary?.shortcutCheckCountClosure?.machineLine);
  const okxRefreshMachineLine = normalizeTextValue(
    summary?.okxCurrentReadinessRefreshWorkflowClosure?.machineLine,
  );
  const okxHeartbeatRefreshLine = buildOkxHeartbeatRefreshLine(summary);
  const okxSchedulerNoOrderContractLine = buildOkxSchedulerNoOrderContractLine(summary);
  const capitalOperatorPacketLine = buildCapitalOperatorPacketLine(summary);
  const capitalLocalExecutorDispatchLine = buildCapitalLocalExecutorDispatchLine(summary);
  const capitalVerifiedPositionSnapshotLine = buildCapitalVerifiedPositionSnapshotLine(summary);
  const okxHeartbeatSchedulerNextRunAt =
    okxHeartbeatRefreshLine.match(/\bschedulerNextRunAt=([^\s｜|]+)/u)?.[1] ?? "";
  const assistantLearningHint = summary?.assistantClosure?.assistantLearningHint ?? null;
  const nextCommandShortRow = assistantLearningHint?.nextCommandShortRow ?? null;
  const nextCommandLine =
    normalizeTextValue(nextCommandShortRow?.machineLine) ||
    normalizeTextValue(nextCommandShortRow?.command) ||
    normalizeTextValue(assistantLearningHint?.nextSafeCommand);
  const parts = [];
  if (machineLine && !existing.includes("shortcutChecks=")) {
    parts.push(`快捷檢查=${machineLine}`);
  }
  if (tradingAgentsLine && !existing.includes("tradingAgents=")) {
    parts.push(`TradingAgents=${tradingAgentsLine}`);
  }
  if (capitalOperatorPacketLine && !existing.includes("capitalOperatorPacket=")) {
    parts.push(`真單Packet=${capitalOperatorPacketLine}`);
  }
  if (capitalLocalExecutorDispatchLine && !existing.includes("capitalLocalExecutorDispatch=")) {
    parts.push(`本地執行器=${capitalLocalExecutorDispatchLine}`);
  }
  if (
    capitalVerifiedPositionSnapshotLine &&
    !existing.includes("capitalVerifiedPositionSnapshot=")
  ) {
    parts.push(`倉位快照=${capitalVerifiedPositionSnapshotLine}`);
  }
  if (okxRefreshMachineLine && !existing.includes("okxCurrentReadinessRefresh=")) {
    parts.push(`OKX刷新=${okxRefreshMachineLine}`);
  }
  if (okxHeartbeatRefreshLine && !existing.includes("okxHeartbeatRefresh=")) {
    parts.push(`OKX心跳=${okxHeartbeatRefreshLine}`);
  } else if (okxHeartbeatSchedulerNextRunAt && !existing.includes("schedulerNextRunAt=")) {
    parts.push(`OKX心跳排程=schedulerNextRunAt=${okxHeartbeatSchedulerNextRunAt}`);
  }
  if (okxSchedulerNoOrderContractLine && !existing.includes("okxSchedulerNoOrderContract=")) {
    parts.push(`OKX合約=${okxSchedulerNoOrderContractLine}`);
  }
  if (nextCommandLine && !existing.includes("nextCommandShortRow=")) {
    parts.push(`下一步指令=${nextCommandLine}`);
  }
  return parts.length > 0 ? `｜${parts.join("｜")}` : "";
}

function buildReceiptPromptMessageSuffix(summary, existingMessage) {
  const prompt = summary?.live_auto_deactivate_receipt_prompt ?? null;
  const machineLine = normalizeTextValue(prompt?.machineLine);
  if (!machineLine || existingMessage.includes("receiptPrompt=")) {
    return "";
  }
  return `｜回關收據命令=${machineLine}`;
}

export function buildMessage(summary, options = {}) {
  let message;
  if (typeof summary?.telegram_summary_oneline_zh_tw === "string") {
    message = summary.telegram_summary_oneline_zh_tw.trim();
  } else if (typeof summary?.telegram_summary_oneline === "string") {
    message = summary.telegram_summary_oneline.trim();
  } else {
    throw new Error("Telegram summary missing telegram_summary_oneline field");
  }
  message = `${message}${buildReceiptPromptMessageSuffix(summary, message)}`;
  if (
    message.includes("shortcutChecks=") &&
    message.includes("capitalOperatorPacket=") &&
    message.includes("capitalLocalExecutorDispatch=") &&
    message.includes("capitalVerifiedPositionSnapshot=") &&
    message.includes("nextCommandShortRow=") &&
    message.includes("okxCurrentReadinessRefresh=") &&
    message.includes("okxHeartbeatRefresh=") &&
    message.includes("okxSchedulerNoOrderContract=") &&
    message.includes("schedulerNextRunAt=") &&
    (options.tradingAgentsReport == null || message.includes("tradingAgents=")) &&
    hasOperationalExecuteRequiredToken(message) &&
    hasOperationalNoOrderWriteToken(message)
  ) {
    return message;
  }
  return `${message}${buildTradingShortcutsMessageSuffix(
    options.tradingShortcutsReport ?? null,
    message,
    options.tradingAgentsReport ?? null,
  )}`;
}

function classifyPublishErrorCode(status) {
  switch (status) {
    case "dry_run_ok":
    case "publish_ok":
      return "OK";
    case "blocked_missing_summary":
      return "BRIDGE_MISSING_SUMMARY";
    case "blocked_missing_target":
      return "BRIDGE_MISSING_TARGET";
    case "publish_failed":
      return "BRIDGE_SEND_FAILED";
    default:
      return "BRIDGE_UNKNOWN_STATUS";
  }
}

function parseFiniteTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeTelegramTarget(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function pickLatestTelegramTarget(history) {
  if (!history || typeof history !== "object" || Array.isArray(history)) {
    return "";
  }
  let bestTarget = "";
  let bestTimestamp = -1;
  for (const [target, payload] of Object.entries(history)) {
    const normalizedTarget = normalizeTelegramTarget(target);
    if (!normalizedTarget) {
      continue;
    }
    let candidateTimestamp = -1;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      for (const value of Object.values(payload)) {
        const parsed = parseFiniteTimestamp(value);
        if (parsed !== null && parsed > candidateTimestamp) {
          candidateTimestamp = parsed;
        }
      }
    }
    if (candidateTimestamp > bestTimestamp) {
      bestTimestamp = candidateTimestamp;
      bestTarget = normalizedTarget;
    }
  }
  return bestTarget;
}

async function resolveTelegramTarget(repoRoot) {
  const envTarget = normalizeTelegramTarget(process.env[TELEGRAM_TARGET_ENV] ?? "");
  if (envTarget) {
    return {
      target: envTarget,
      source: "env",
      sourcePath: null,
    };
  }
  const historyPath = path.join(repoRoot, TELEGRAM_SENT_MESSAGES_REL);
  let history = null;
  try {
    history = await readJson(historyPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const historyTarget = pickLatestTelegramTarget(history);
  if (!historyTarget) {
    return {
      target: "",
      source: "missing",
      sourcePath: toPosix(path.relative(repoRoot, historyPath)),
    };
  }
  return {
    target: historyTarget,
    source: "sent_messages_history",
    sourcePath: toPosix(path.relative(repoRoot, historyPath)),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const repoRoot = process.cwd();
  const stateDir = path.join(repoRoot, STATE_DIR_REL);
  const summaryPath = options.summaryPath
    ? path.resolve(repoRoot, options.summaryPath)
    : path.join(stateDir, SUMMARY_FILE_NAME);
  const reportPath = options.reportPath
    ? path.resolve(repoRoot, options.reportPath)
    : path.join(stateDir, REPORT_LATEST_FILE_NAME);
  const generatedAt = new Date().toISOString();

  let summary;
  try {
    summary = await readJson(summaryPath);
  } catch (error) {
    const report = {
      schema: REPORT_SCHEMA,
      generatedAt,
      status: "blocked_missing_summary",
      errorCode: classifyPublishErrorCode("blocked_missing_summary"),
      dryRun: options.dryRun,
      summaryPath: toPosix(path.relative(repoRoot, summaryPath)),
      message: `summary read failed: ${error instanceof Error ? error.message : String(error)}`,
      next_safe_task: "pnpm autonomous:controlled:run -- --json",
    };
    await writeJson(reportPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const tradingShortcutsReport = await readOptionalJson(
    path.join(stateDir, TELEGRAM_TRADING_SHORTCUTS_REPORT_NAME),
  );
  const tradingAgentsReport = await readOptionalJson(
    path.join(stateDir, TRADINGAGENTS_SUMMARY_REPORT_NAME),
  );

  const targetResolution = await resolveTelegramTarget(repoRoot);
  const target = targetResolution.target;
  if (!target) {
    const report = {
      schema: REPORT_SCHEMA,
      generatedAt,
      status: "blocked_missing_target",
      errorCode: classifyPublishErrorCode("blocked_missing_target"),
      dryRun: options.dryRun,
      summaryPath: toPosix(path.relative(repoRoot, summaryPath)),
      reportPath: toPosix(path.relative(repoRoot, reportPath)),
      target: null,
      targetSource: targetResolution.source,
      targetSourcePath: targetResolution.sourcePath ?? null,
      message:
        "OPENCLAW_TELEGRAM_STATUS_TARGET is required for telegram publish bridge; fallback target not found",
      next_safe_task:
        "set OPENCLAW_TELEGRAM_STATUS_TARGET and rerun pnpm autonomous:controlled:telegram:publish",
    };
    await writeJson(reportPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const message = buildMessage(summary, { tradingShortcutsReport, tradingAgentsReport });
  const args = [
    "message",
    "send",
    "--channel",
    "telegram",
    "--target",
    target,
    "--message",
    message,
  ];
  const threadId = (process.env.OPENCLAW_TELEGRAM_STATUS_THREAD_ID ?? "").trim();
  if (threadId) {
    args.push("--thread-id", threadId);
  }
  if (options.dryRun) {
    args.push("--dry-run");
  }

  const maxAttempts = parsePositiveIntegerEnv(RETRY_MAX_ATTEMPTS_ENV, 2, 1, 5);
  const baseDelayMs = parsePositiveIntegerEnv(RETRY_BASE_DELAY_MS_ENV, 1500, 100, 30000);
  if (options.dryRun) {
    const messageTokenCounts = buildMessageTokenCounts(message);
    const report = {
      schema: REPORT_SCHEMA,
      generatedAt,
      status: "dry_run_ok",
      errorCode: classifyPublishErrorCode("dry_run_ok"),
      dryRun: true,
      dryRunNoSend: true,
      summaryPath: toPosix(path.relative(repoRoot, summaryPath)),
      reportPath: toPosix(path.relative(repoRoot, reportPath)),
      target,
      targetSource: targetResolution.source,
      targetSourcePath: targetResolution.sourcePath ?? null,
      message,
      messageTokenCounts,
      messageTokenCountsSummaryZhTw: buildMessageTokenCountsSummaryZhTw(messageTokenCounts),
      threadId: threadId || null,
      command: `node openclaw.mjs ${args.join(" ")}`,
      commandExitCode: 0,
      commandDurationMs: 0,
      commandErrorCode: "DRY_RUN_NO_SEND",
      commandAttemptsUsed: 0,
      commandMaxAttempts: maxAttempts,
      commandRetryBaseDelayMs: baseDelayMs,
      next_safe_task: "pnpm autonomous:controlled:run -- --json",
    };
    await writeJson(reportPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  let commandResult = null;
  let attemptUsed = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptUsed = attempt;
    commandResult = await runNodeOpenClaw(args, repoRoot);
    if (commandResult.exitCode === 0) {
      break;
    }
    if (attempt < maxAttempts) {
      const delayMs = baseDelayMs * attempt;
      await sleep(delayMs);
    }
  }
  if (commandResult === null) {
    throw new Error("telegram publish bridge did not execute any attempts");
  }

  const status =
    commandResult.exitCode === 0
      ? options.dryRun
        ? "dry_run_ok"
        : "publish_ok"
      : "publish_failed";
  const messageTokenCounts = buildMessageTokenCounts(message);
  const report = {
    schema: REPORT_SCHEMA,
    generatedAt,
    status,
    errorCode: classifyPublishErrorCode(status),
    dryRun: options.dryRun,
    summaryPath: toPosix(path.relative(repoRoot, summaryPath)),
    reportPath: toPosix(path.relative(repoRoot, reportPath)),
    target,
    targetSource: targetResolution.source,
    targetSourcePath: targetResolution.sourcePath ?? null,
    message,
    messageTokenCounts,
    messageTokenCountsSummaryZhTw: buildMessageTokenCountsSummaryZhTw(messageTokenCounts),
    threadId: threadId || null,
    command: `node openclaw.mjs ${args.join(" ")}`,
    commandExitCode: commandResult.exitCode,
    commandDurationMs: commandResult.durationMs,
    commandErrorCode: commandResult.errorCode ?? null,
    commandAttemptsUsed: attemptUsed,
    commandMaxAttempts: maxAttempts,
    commandRetryBaseDelayMs: baseDelayMs,
    next_safe_task:
      commandResult.exitCode === 0
        ? "pnpm autonomous:controlled:run -- --json"
        : "check telegram channel setup then rerun pnpm autonomous:controlled:telegram:publish",
  };
  await writeJson(reportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (commandResult.exitCode !== 0) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
if (invokedPath === currentPath) {
  await main().catch((error) => {
    process.stderr.write(
      `openclaw controlled task runner telegram publish failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
