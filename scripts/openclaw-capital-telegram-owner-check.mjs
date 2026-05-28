import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCapitalServiceStatus } from "./openclaw-capital-service-status.mjs";

const DEFAULT_PANEL_PATH = path.join(".openclaw", "quote", "capital-telegram-owner-check.json");
const DEFAULT_REPORT_PATH = path.join(
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-telegram-owner-check-latest.json",
);

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function writeJsonWithHash(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

function resolveOwnerState(poller) {
  if (!poller?.available) {
    return {
      status: "degraded_missing_telegram_status",
      ready: false,
      receiver: "unknown",
      capitalMode: "unknown",
      secondPoller: "unknown",
      blockerCode: "telegram_status_missing",
      fix: "先刷新 Capital service status，確認 Telegram owner 欄位。",
    };
  }
  if (poller.duplicatePollerDetected) {
    return {
      status: "blocked_duplicate_poller",
      ready: false,
      receiver: "conflict",
      capitalMode: poller.pollingEnabled ? "polling" : "unknown",
      secondPoller: "有",
      blockerCode: "duplicate_poller_detected",
      fix: "停止多餘 Telegram getUpdates poller，保留 OpenClaw Gateway 單一入口。",
    };
  }
  if (poller.pollingEnabled) {
    return {
      status: "blocked_capital_polling_enabled",
      ready: false,
      receiver: poller.pollingOwner || "capital_hft_service",
      capitalMode: "polling",
      secondPoller: "風險",
      blockerCode: "capital_telegram_polling_enabled",
      fix: "用不帶 --telegram-polling 的方式重啟 CapitalHftService。",
    };
  }
  if (poller.pollState === "poll_error") {
    return {
      status: "blocked_poll_error",
      ready: false,
      receiver: "unknown",
      capitalMode: "send-only",
      secondPoller: "unknown",
      blockerCode: "telegram_poll_error",
      fix: "先修復 Telegram polling error，再允許 Telegram 查價入口。",
    };
  }
  return {
    status: "ready_single_owner",
    ready: true,
    receiver: "openclaw_gateway",
    capitalMode: "send-only",
    secondPoller: "無",
    blockerCode: "",
    fix: "",
  };
}

function buildReplyLine(report) {
  const statusLabel = report.ready ? "正常" : `封鎖:${report.blockerCode || report.status}`;
  return [
    `[OpenClaw Telegram 自檢] 狀態=${statusLabel}`,
    `收訊入口=${report.receiverLabel}`,
    `CapitalHftService=${report.capitalMode}`,
    `第二個poller=${report.secondPoller}`,
    `目前=${report.pollerSummary}`,
    report.fix ? `修正=${report.fix}` : "修正=無",
    "真單=封鎖（風控未開啟）",
  ].join("｜");
}

export function buildCapitalTelegramOwnerCheck(serviceStatus, options = {}) {
  const poller = serviceStatus?.telegramPoller ?? {};
  const ownerState = resolveOwnerState(poller);
  const report = {
    schema: "openclaw.capital.telegram-owner-check.v1",
    generatedAt: new Date().toISOString(),
    status: ownerState.status,
    ready: ownerState.ready,
    source: "Capital service telegramPoller status",
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    expectedReceiver: "openclaw_gateway",
    receiver: ownerState.receiver,
    receiverLabel:
      ownerState.receiver === "openclaw_gateway" ? "OpenClaw Gateway" : ownerState.receiver,
    capitalMode: ownerState.capitalMode,
    secondPoller: ownerState.secondPoller,
    blockerCode: ownerState.blockerCode,
    fix: ownerState.fix,
    pollerSummary: text(poller.summary, "missing"),
    poller: {
      available: poller.available === true,
      pollingEnabled: poller.pollingEnabled === true,
      pollingOwner: text(poller.pollingOwner, "missing"),
      pollState: text(poller.pollState, "missing"),
      duplicatePollerDetected: poller.duplicatePollerDetected === true,
      duplicatePollerCount: Number.isFinite(Number(poller.duplicatePollerCount))
        ? Number(poller.duplicatePollerCount)
        : 0,
      consecutivePollErrors: Number.isFinite(Number(poller.consecutivePollErrors))
        ? Number(poller.consecutivePollErrors)
        : 0,
      lastPollErrorStatus: text(poller.lastPollErrorStatus),
      lastPollErrorMessage: text(poller.lastPollErrorMessage),
      lastDuplicatePollerAt: text(poller.lastDuplicatePollerAt),
    },
    serviceStatusReady: serviceStatus?.ready === true,
    files: {
      serviceStatusReport: options.serviceStatusReport || "",
      panel: options.panelPath || "",
      report: options.reportPath || "",
    },
    nextSafeTask: ownerState.ready
      ? "將 Telegram owner 自檢接入 /quote status 與背景監控報表。"
      : ownerState.fix,
  };
  report.replyLine = buildReplyLine(report);
  return report;
}

export async function readCapitalTelegramOwnerCheck(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const panelPath = path.resolve(options.panelPath || path.join(repoRoot, DEFAULT_PANEL_PATH));
  const reportPath = path.resolve(options.reportPath || path.join(repoRoot, DEFAULT_REPORT_PATH));
  const serviceStatus = await readCapitalServiceStatus(options);
  return buildCapitalTelegramOwnerCheck(serviceStatus, {
    panelPath,
    reportPath,
    serviceStatusReport: serviceStatus?.files?.report || "",
  });
}

export async function writeCapitalTelegramOwnerCheck(report, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const panelPath = path.resolve(options.panelPath || path.join(repoRoot, DEFAULT_PANEL_PATH));
  const reportPath = path.resolve(options.reportPath || path.join(repoRoot, DEFAULT_REPORT_PATH));
  await writeJsonWithHash(panelPath, {
    ...report,
    files: { ...report.files, panel: panelPath, report: reportPath },
  });
  await writeJsonWithHash(reportPath, {
    ...report,
    files: { ...report.files, panel: panelPath, report: reportPath },
  });
  return { panelPath, reportPath };
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    capitalRoot: "",
    panelPath: "",
    reportPath: "",
    writeState: false,
    json: false,
    strictExit: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--capital-root") {
      options.capitalRoot = argv[++index] ?? options.capitalRoot;
    } else if (arg.startsWith("--capital-root=")) {
      options.capitalRoot = arg.slice("--capital-root=".length);
    } else if (arg === "--panel") {
      options.panelPath = argv[++index] ?? options.panelPath;
    } else if (arg.startsWith("--panel=")) {
      options.panelPath = arg.slice("--panel=".length);
    } else if (arg === "--report") {
      options.reportPath = argv[++index] ?? options.reportPath;
    } else if (arg.startsWith("--report=")) {
      options.reportPath = arg.slice("--report=".length);
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--strict-exit") {
      options.strictExit = true;
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const report = await readCapitalTelegramOwnerCheck({ ...options, repoRoot });
  const outputs = options.writeState
    ? await writeCapitalTelegramOwnerCheck(report, { ...options, repoRoot })
    : {};
  const payload = {
    ...report,
    outputPath: outputs.panelPath ?? "",
    reportPath: outputs.reportPath ?? "",
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.replyLine}\n`);
  }
  process.exitCode =
    report.liveTradingEnabled || report.writeTradingEnabled
      ? 2
      : options.strictExit && !report.ready
        ? 2
        : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital telegram owner check failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
