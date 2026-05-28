import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/brokerdesk-state-dir.mjs";
import { readCapitalQuoteStatus } from "./openclaw-capital-quote-status.mjs";

const STABLE_TICK_FRESHNESS_SECONDS = 30;

function defaultDashboardPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-automation-health-dashboard.json");
}

function defaultQuoteStatusPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-quote-status.json");
}

function defaultServiceStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "service", "auto-trading-watch-service.json");
}

function defaultLatestQuoteEventPath() {
  return path.join(resolveCapitalHftStateDir(), "capital_latest_quote_event.json");
}

function defaultOutputPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-tick-diagnostic.json");
}

function defaultMarkdownPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-tick-diagnostic.md");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function captureHighResClock() {
  const epochMs = performance.timeOrigin + performance.now();
  return {
    observedAt: new Date(epochMs).toISOString(),
    observedAtEpochMs: epochMs,
    observedAtEpochMicros: Math.round(epochMs * 1000),
  };
}

async function readJson(filePath, label) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} not found: ${filePath}`, { cause: error });
    }
    throw new Error(
      `Invalid ${label} JSON: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function readOptionalJson(filePath, fallback) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("Unexpected end of JSON input") ||
      message.includes("Unterminated string") ||
      message.includes("Unexpected end of data") ||
      message.includes("empty JSON content")
    ) {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeTextWithSha(filePath, text) {
  const normalized = text.endsWith("\n") ? text : `${text}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, normalized, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(normalized)}\n`, "ascii");
}

function bool(value) {
  return value === true;
}

function numberOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stringOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function parseDecimalPlaces(message, fallback = 2) {
  const match = /decimal=(\d+)/i.exec(message ?? "");
  if (!match) {
    return fallback;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function formatQuoteValue(value, decimalPlaces) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "";
  }
  const scale = 10 ** Math.max(0, decimalPlaces);
  return (numeric / scale).toFixed(Math.max(0, decimalPlaces));
}

function renderMarkdown(report) {
  return [
    "# OpenClaw 即時 Tick 診斷",
    "",
    `- status: \`${report.status}\``,
    `- monitorFreshness: \`${report.monitorFreshness.status}\``,
    `- monitorAgeSeconds: \`${report.monitorFreshness.ageSeconds}\``,
    `- realtimeFreshness: \`${report.realtimeFreshness.status}\``,
    `- realtimeAgeSeconds: \`${report.realtimeFreshness.ageSeconds}\``,
    `- latestOverallQuote: \`${report.latestOverallQuote.stockNo}/${report.latestOverallQuote.stockName} close=${report.latestOverallQuote.close} bid=${report.latestOverallQuote.bid} ask=${report.latestOverallQuote.ask}\``,
    `- freshQuoteAvailable: \`${report.freshQuoteAvailable}\``,
    `- latestTradeQuote: \`${report.latestTradeQuote.stockNo}/${report.latestTradeQuote.stockName} close=${report.latestTradeQuote.close} bid=${report.latestTradeQuote.bid} ask=${report.latestTradeQuote.ask}\``,
    `- freshTradeQuote: \`${report.freshTradeQuote?.stockNo ? `${report.freshTradeQuote.stockNo}/${report.freshTradeQuote.stockName} close=${report.freshTradeQuote.close} bid=${report.freshTradeQuote.bid} ask=${report.freshTradeQuote.ask}` : "NONE"}\``,
    `- monitorRunning: \`${report.tick.monitorRunning}\``,
    `- realtimeRunning: \`${report.tick.realtimeRunning}\``,
    `- bridgeStatus: \`${report.bridge.status}\``,
    `- bridgeReady: \`${report.bridge.ready}\``,
    `- latestCallbackAt: \`${report.latestCallback.receivedAt}\``,
    `- latestCallbackSource: \`${report.latestCallback.eventSource}\``,
    `- latestCallbackStock: \`${report.latestCallback.stockNo}\``,
    `- latestCallbackBidAsk: \`${report.latestCallback.bid}/${report.latestCallback.ask}\``,
    `- bidAskUsable: \`${report.latestCallback.bidAskUsable}\``,
    `- marketSession: \`${report.marketSession.label}\``,
    `- nextSafeTask: ${report.recommendation.nextSafeTask}`,
    "",
    "## Files",
    `- dashboardPath: \`${report.files.dashboardPath}\``,
    `- quoteStatusPath: \`${report.files.quoteStatusPath}\``,
    `- latestQuoteEventPath: \`${report.files.latestQuoteEventPath}\``,
    `- reportPath: \`${report.files.reportPath}\``,
    `- markdownPath: \`${report.files.markdownPath}\``,
  ].join("\n");
}

export function buildTickDiagnostic({
  dashboard,
  quoteStatus,
  latestQuoteEvent,
  serviceState,
  dashboardPath,
  quoteStatusPath,
  latestQuoteEventPath,
  reportPath,
  markdownPath,
}) {
  const latestOverallQuote = latestQuoteEvent ?? {};
  const selectedQuote = quoteStatus?.diagnostics?.latestQuote ?? latestQuoteEvent ?? {};
  const monitorFreshnessStatus = stringOr(dashboard?.quoteFreshness?.status, "");
  const monitorAgeSeconds = numberOr(dashboard?.quoteFreshness?.ageSeconds, -1);
  const monitorMaxFreshSeconds = numberOr(dashboard?.quoteFreshness?.maxFreshSeconds, 0);
  const realtimeFreshnessStatus = stringOr(quoteStatus?.quoteProof?.freshnessStatus, "");
  const realtimeAgeSeconds = numberOr(quoteStatus?.quoteProof?.freshnessAgeSeconds, -1);
  const realtimeMaxFreshSeconds = numberOr(
    quoteStatus?.quoteProof?.maxAllowedFreshAgeSeconds ?? quoteStatus?.quoteProof?.maxFreshSeconds,
    2,
  );
  const monitorRunning =
    monitorFreshnessStatus === "fresh" &&
    monitorAgeSeconds >= 0 &&
    monitorAgeSeconds <= monitorMaxFreshSeconds;
  const realtimeRunning =
    realtimeFreshnessStatus === "fresh" &&
    realtimeAgeSeconds >= 0 &&
    realtimeAgeSeconds <= realtimeMaxFreshSeconds;
  const callbackReceivedAt = stringOr(
    selectedQuote?.receivedAt,
    quoteStatus?.diagnostics?.latestQuote?.receivedAt ?? latestQuoteEvent?.receivedAt ?? "",
  );
  const callbackBid = stringOr(
    selectedQuote?.bid,
    quoteStatus?.diagnostics?.latestQuote?.bid ?? "",
  );
  const callbackAsk = stringOr(
    selectedQuote?.ask,
    quoteStatus?.diagnostics?.latestQuote?.ask ?? "",
  );
  const callbackStockNo = stringOr(
    selectedQuote?.stockNo,
    quoteStatus?.diagnostics?.latestQuote?.stockNo ?? "",
  );
  const callbackStockName = stringOr(
    selectedQuote?.stockName,
    quoteStatus?.diagnostics?.latestQuote?.stockName ?? "",
  );
  const callbackSource = stringOr(
    selectedQuote?.eventSource,
    quoteStatus?.diagnostics?.latestQuote?.eventSource ?? "",
  );
  const callbackMessage = stringOr(
    selectedQuote?.message,
    quoteStatus?.diagnostics?.latestQuote?.message ?? "",
  );
  const callbackQty = stringOr(
    selectedQuote?.qty,
    quoteStatus?.diagnostics?.latestQuote?.qty ?? "",
  );
  const callbackLogFile = stringOr(
    latestQuoteEvent?.sourceLogFile,
    quoteStatus?.diagnostics?.latestQuote?.sourceLogFile ?? "",
  );
  const callbackLogLine = numberOr(
    latestQuoteEvent?.sourceLogLine,
    quoteStatus?.diagnostics?.latestQuote?.sourceLogLine ?? 0,
  );
  const decimalPlaces = parseDecimalPlaces(callbackMessage, 2);
  const bidAskUsable = bool(quoteStatus?.diagnostics?.bidAskUsable);
  const daemon = {
    status: stringOr(serviceState?.status, ""),
    pid: Number.isFinite(Number(serviceState?.pid)) ? Number(serviceState.pid) : 0,
    watchScript: stringOr(serviceState?.watchScript, ""),
    nextSafeTask: stringOr(serviceState?.nextSafeTask, ""),
  };
  const marketSession = {
    value: stringOr(quoteStatus?.session?.marketSession, "unknown"),
    label: stringOr(quoteStatus?.session?.marketSessionLabel, "未知"),
    tradingOpen: quoteStatus?.session?.tradingOpen === true,
  };
  const bridgeSource = quoteStatus?.bridge ?? quoteStatus?.health ?? {};
  const bridge = {
    status: stringOr(bridgeSource?.status ?? bridgeSource?.bridgeStatus, "unknown"),
    ready: bool(bridgeSource?.ready ?? bridgeSource?.bridgeReady),
    overallReady: bool(bridgeSource?.overallReady ?? bridgeSource?.overallReady),
    quoteEventConfirmed: bool(
      bridgeSource?.quoteEventConfirmed ?? bridgeSource?.quoteEventConfirmed,
    ),
    lastHeartbeatAt: stringOr(bridgeSource?.lastHeartbeatAt, ""),
    keepAliveUntil: stringOr(bridgeSource?.keepAliveUntil, ""),
    brokerActionRequired: bool(bridgeSource?.brokerActionRequired),
    currentBlockingCode: stringOr(bridgeSource?.currentBlockingCode, ""),
    capitalAccountSet: bool(bridgeSource?.capitalAccountSet),
    capitalAttempted: bool(bridgeSource?.capitalAttempted),
    capitalMessage: stringOr(bridgeSource?.capitalMessage, ""),
    lastLogin1115Historical: bool(bridgeSource?.lastLogin1115Historical),
  };
  const tradeQuote = {
    stockNo: callbackStockNo,
    stockName: callbackStockName,
    close: formatQuoteValue(
      selectedQuote?.close ?? quoteStatus?.diagnostics?.latestQuote?.close ?? "",
      decimalPlaces,
    ),
    bid: formatQuoteValue(callbackBid, decimalPlaces),
    ask: formatQuoteValue(callbackAsk, decimalPlaces),
    qty: callbackQty,
    freshnessStatus: realtimeFreshnessStatus,
    freshnessAgeSeconds: realtimeAgeSeconds,
    marketSessionLabel: marketSession.label,
    decimalPlaces,
  };
  const freshQuoteAvailable = realtimeRunning;
  const freshTradeQuote = freshQuoteAvailable ? tradeQuote : null;
  const clock = captureHighResClock();
  const status = realtimeRunning
    ? "tick_running"
    : monitorRunning
      ? "monitor_fresh_realtime_stale"
      : "monitor_stale";

  return {
    schema: "openclaw.capital.auto-trading-tick-diagnostic.v1",
    generatedAt: new Date().toISOString(),
    provider: "capital",
    mode: "paper",
    readOnlyQuoteOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    hftLikeAutomation: true,
    status,
    clock,
    monitorFreshness: {
      status: monitorFreshnessStatus,
      ageSeconds: monitorAgeSeconds,
      maxFreshSeconds: monitorMaxFreshSeconds,
      running: monitorRunning,
    },
    realtimeFreshness: {
      status: realtimeFreshnessStatus,
      ageSeconds: realtimeAgeSeconds,
      maxFreshSeconds: realtimeMaxFreshSeconds,
      running: realtimeRunning,
    },
    bridge,

    tick: {
      monitorRunning,
      realtimeRunning,
      currentRunning: realtimeRunning,
      healthFreshnessStatus: monitorFreshnessStatus,
      healthFreshnessAgeSeconds: monitorAgeSeconds,
      realTimeFreshnessStatus: realtimeFreshnessStatus,
      realTimeFreshnessAgeSeconds: realtimeAgeSeconds,
    },
    latestCallback: {
      receivedAt: callbackReceivedAt,
      eventSource: callbackSource,
      stockNo: callbackStockNo,
      stockName: callbackStockName,
      bid: callbackBid,
      ask: callbackAsk,
      qty: callbackQty,
      bidAskUsable,
      message: callbackMessage,
      sourceLogFile: callbackLogFile,
      sourceLogLine: callbackLogLine,
    },
    latestOverallQuote: {
      receivedAt: stringOr(latestOverallQuote?.receivedAt, ""),
      eventSource: stringOr(latestOverallQuote?.eventSource, ""),
      stockNo: stringOr(latestOverallQuote?.stockNo, ""),
      stockName: stringOr(latestOverallQuote?.stockName, ""),
      close: formatQuoteValue(latestOverallQuote?.close ?? "", decimalPlaces),
      bid: formatQuoteValue(latestOverallQuote?.bid ?? "", decimalPlaces),
      ask: formatQuoteValue(latestOverallQuote?.ask ?? "", decimalPlaces),
      qty: stringOr(latestOverallQuote?.qty, ""),
      message: stringOr(latestOverallQuote?.message, ""),
    },
    freshQuoteAvailable,
    tradeQuote: freshTradeQuote,
    latestTradeQuote: tradeQuote,
    freshTradeQuote,
    marketSession,
    daemon,
    recommendation: {
      nextSafeTask: realtimeRunning
        ? "即時 tick 已運行，持續 heartbeat 監看，不要啟用真實下單。"
        : monitorRunning
          ? "監看層正常，但即時 tick 尚未恢復；等待新的 SKQuoteLib callback。"
          : "先修復 CapitalHftService 報價來源，再等待新的 SKQuoteLib callback。",
    },
    files: {
      dashboardPath,
      quoteStatusPath,
      latestQuoteEventPath,
      reportPath,
      markdownPath,
    },
  };
}

export async function runAutoTradingTickDiagnostic(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const dashboardPath = path.resolve(options.dashboardPath || defaultDashboardPath(repoRoot));
  const quoteStatusPath = path.resolve(options.quoteStatusPath || defaultQuoteStatusPath(repoRoot));
  const latestQuoteEventPath = path.resolve(
    options.latestQuoteEventPath || defaultLatestQuoteEventPath(),
  );
  const reportPath = path.resolve(options.reportPath || defaultOutputPath(repoRoot));
  const markdownPath = path.resolve(options.markdownPath || defaultMarkdownPath(repoRoot));

  const serviceStatePath = path.resolve(
    options.serviceStatePath || defaultServiceStatePath(repoRoot),
  );
  const [dashboard, latestQuoteEvent, serviceState] = await Promise.all([
    readJson(dashboardPath, "capital-hft automation health dashboard"),
    readOptionalJson(latestQuoteEventPath, {}),
    readOptionalJson(serviceStatePath, {}),
  ]);
  const quoteStatus = await readCapitalQuoteStatus({
    dashboardPath,
    repoRoot,
    stateDir: path.dirname(latestQuoteEventPath),
    maxFreshAgeSeconds: STABLE_TICK_FRESHNESS_SECONDS,
    marketCode: "TXF",
    targetStockNo: "TX00AM",
    targetStockNos: ["TX00AM", "TX00", "TXFR1"],
    quoteAliases: ["TX00AM", "TX00", "TXFR1", "TXF"],
  });

  const report = buildTickDiagnostic({
    dashboard,
    quoteStatus,
    latestQuoteEvent,
    serviceState,
    dashboardPath,
    quoteStatusPath,
    latestQuoteEventPath,
    reportPath,
    markdownPath,
  });
  if (options.writeState !== false) {
    await writeJsonWithSha(reportPath, report);
    await writeTextWithSha(markdownPath, renderMarkdown(report));
  }
  return {
    report,
    files: {
      dashboardPath,
      quoteStatusPath,
      latestQuoteEventPath,
      reportPath,
      markdownPath,
    },
  };
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    dashboardPath: "",
    quoteStatusPath: "",
    latestQuoteEventPath: "",
    reportPath: "",
    markdownPath: "",
    writeState: true,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--dashboard") {
      options.dashboardPath = argv[++index] ?? options.dashboardPath;
    } else if (arg.startsWith("--dashboard=")) {
      options.dashboardPath = arg.slice("--dashboard=".length);
    } else if (arg === "--quote-status") {
      options.quoteStatusPath = argv[++index] ?? options.quoteStatusPath;
    } else if (arg.startsWith("--quote-status=")) {
      options.quoteStatusPath = arg.slice("--quote-status=".length);
    } else if (arg === "--latest-quote-event") {
      options.latestQuoteEventPath = argv[++index] ?? options.latestQuoteEventPath;
    } else if (arg.startsWith("--latest-quote-event=")) {
      options.latestQuoteEventPath = arg.slice("--latest-quote-event=".length);
    } else if (arg === "--report") {
      options.reportPath = argv[++index] ?? options.reportPath;
    } else if (arg.startsWith("--report=")) {
      options.reportPath = arg.slice("--report=".length);
    } else if (arg === "--markdown") {
      options.markdownPath = argv[++index] ?? options.markdownPath;
    } else if (arg.startsWith("--markdown=")) {
      options.markdownPath = arg.slice("--markdown=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--read-only") {
      options.writeState = false;
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runAutoTradingTickDiagnostic(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw auto-trading tick diagnostic",
        `status=${result.report.status}`,
        `freshQuote=${result.report.freshQuoteAvailable ? "yes" : "no"}`,
        `currentQuote=${result.report.freshTradeQuote?.stockNo ? `${result.report.freshTradeQuote.stockNo}/${result.report.freshTradeQuote.stockName}` : "NONE"}`,
        `latestQuote=${result.report.latestTradeQuote?.stockNo ? `${result.report.latestTradeQuote.stockNo}/${result.report.latestTradeQuote.stockName}` : "NONE"}`,
        `rawQuote=${result.report.latestOverallQuote?.stockNo || "NONE"}`,
        `bg=${result.report.bridge.status}${result.report.bridge.ready ? ":ready" : ""}${result.report.bridge.quoteEventConfirmed ? ":confirmed" : ""}`,
        `bgHeartbeat=${result.report.bridge.lastHeartbeatAt || "N/A"}`,
        `monitor=${result.report.tick.monitorRunning ? "yes" : "no"}`,
        `realtime=${result.report.tick.realtimeRunning ? "yes" : "no"}`,
        `latestCallbackAt=${result.report.latestCallback.receivedAt}`,
        `report=${result.files.reportPath}`,
      ].join(" ") + "\n",
    );
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `auto-trading tick diagnostic failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
