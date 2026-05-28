import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildTickDiagnostic,
  runAutoTradingTickDiagnostic,
} from "./openclaw-auto-trading-tick-diagnostic.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auto-trading-tick-"));
const repoRoot = path.join(tempRoot, "repo");
const quoteDir = path.join(repoRoot, ".openclaw", "quote");
await fs.mkdir(quoteDir, { recursive: true });

const dashboardPath = path.join(quoteDir, "capital-automation-health-dashboard.json");
const quoteStatusPath = path.join(quoteDir, "capital-quote-status.json");
const latestQuoteEventPath = path.join(
  tempRoot,
  "CapitalHftService",
  "state",
  "capital_latest_quote_event.json",
);
const serviceStatePath = path.join(
  repoRoot,
  ".openclaw",
  "service",
  "auto-trading-watch-service.json",
);
await fs.mkdir(path.dirname(latestQuoteEventPath), { recursive: true });

const dashboard = {
  schema: "capital-hft.capital.automation-health-dashboard.v1",
  generatedAt: new Date().toISOString(),
  readOnly: true,
  liveTradingEnabled: false,
  writeTradingEnabled: false,
  healthStatus: "completed",
  guard: { active: false, nextAllowedAt: "", lastCode: "", lastMethod: "" },
  bridge: {
    status: "connected",
    ready: true,
    brokerActionRequired: false,
    currentBlockingCode: "",
    lastLogin1115Historical: false,
  },
  capitalHftQueue: {
    completed: true,
    nextStartIndex: 14622,
    lastRunStatus: "subscription-window-accepted",
    quoteUniverseCount: 18404,
    distinctQuoteCodeCount: 14622,
    completionUniverseCount: 14622,
    completionBasis: "distinctQuoteCodeCount",
    quoteProofStatus: "confirmed",
    quoteProofFreshness: "fresh",
  },
  openClawQueue: { ready: true, completed: true },
  quoteFreshness: {
    status: "fresh",
    latestStock: "MXFFX999",
    latestStockName: "客小台現貨標的",
    ageSeconds: 120,
    maxFreshSeconds: 14400,
  },
  productMapping: { ready: true, status: "completed", productFamilyRows: 409 },
  domesticOverseasClassification: {
    ready: true,
    status: "completed",
    mappingAppliedRows: 14622,
    distinctQuoteCodes: 14622,
  },
  readiness: {
    queueCompleted: true,
    openClawReady: true,
    openClawCompleted: true,
    freshnessReady: true,
    mappingReady: true,
    classificationReady: true,
    allReadOnlyMonitorsReady: true,
  },
  nextSafeTask: "只維持 heartbeat 健康檢查；不要重跑全商品。",
};

const quoteStatus = {
  schema: "openclaw.capital.quote-status.v1",
  generatedAt: new Date().toISOString(),
  provider: "capital",
  source: "CapitalHftService health dashboard",
  readOnly: true,
  loginAttempted: false,
  liveTradingEnabled: false,
  writeTradingEnabled: false,
  status: "stale",
  ready: false,
  reason: "fixture",
  strategyGate: {
    ready: false,
    status: "deny_strategy_context",
    reason: "fixture",
  },
  guard: { active: false, lastCode: "", nextAllowedAt: "" },
  health: {
    bridgeStatus: "connected",
    bridgeReady: true,
    brokerActionRequired: false,
    currentBlockingCode: "",
    lastLogin1115Historical: false,
  },
  quoteProof: {
    status: "confirmed",
    freshness: "stale",
    latestStock: "MXFFX999",
    latestStockName: "客小台現貨標的",
    freshnessStatus: "stale",
    freshnessAgeSeconds: 999999,
    maxFreshSeconds: 2,
    maxAllowedFreshAgeSeconds: 2,
  },
  completion: {
    queueCompleted: true,
    openClawReady: true,
    openClawCompleted: true,
    lastRunStatus: "subscription-window-accepted",
    quoteUniverseCount: 18404,
    distinctQuoteCodeCount: 14622,
    completionUniverseCount: 14622,
    completionBasis: "distinctQuoteCodeCount",
    nextStartIndex: 14622,
  },
  monitors: {
    freshnessReady: true,
    mappingReady: true,
    classificationReady: true,
    allReadOnlyMonitorsReady: true,
    mappingFamilies: 409,
    classificationMappedRows: 14622,
    classificationDistinctQuoteCodes: 14622,
  },
  diagnostics: {
    bidAskUsable: false,
    blockers: ["freshness_stale", "bid_ask_not_usable"],
    latestQuote: {
      receivedAt: "2026-05-06 23:23:19.384",
      eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
      message: "fixture",
      stockNo: "MXFFX999",
      stockName: "客小台現貨標的",
      close: "4113885",
      bid: "0",
      ask: "0",
      qty: "0",
    },
  },
  nextSafeTask: "等待 CapitalHftService 寫入更新的 quote event；不要登入、不要推進 StartIndex。",
  files: {
    dashboard: "",
    sourceDashboardPath: dashboardPath,
    freshnessState: "",
    productMappingState: "",
    domesticOverseasState: "",
  },
};

const latestQuoteEvent = {
  schema: "capital-hft.capital.quote-event.v1",
  provider: "capital",
  receivedAt: "2026-05-06 23:23:19.384",
  eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
  message: "收到群益報價事件",
  stockNo: "MXFFX999",
  stockName: "客小台現貨標的",
  close: "4113885",
  bid: "0",
  ask: "0",
  qty: "0",
  sourceLogFile: "D:\\群益及元大API\\CapitalHftService\\logs\\background-quotes\\20260506.log",
  sourceLogLine: 83012,
};

await writeJson(dashboardPath, dashboard);
await writeJson(quoteStatusPath, quoteStatus);
await writeJson(latestQuoteEventPath, latestQuoteEvent);
await writeJson(path.join(tempRoot, "CapitalHftService", "state", "openclaw_quote_bridge.json"), {
  status: "connected",
  overallReady: true,
  providers: { capital: { brokerActionRequired: false } },
  currentBlockingCode: "",
  quoteUniverseCount: 18404,
});

const report = await runAutoTradingTickDiagnostic({
  repoRoot,
  dashboardPath,
  quoteStatusPath,
  latestQuoteEventPath,
  serviceStatePath,
  reportPath: path.join(quoteDir, "capital-tick-diagnostic.json"),
  markdownPath: path.join(quoteDir, "capital-tick-diagnostic.md"),
});

if (report.report.schema !== "openclaw.capital.auto-trading-tick-diagnostic.v1") {
  throw new Error(`unexpected schema: ${report.report.schema}`);
}
if (report.report.status !== "monitor_fresh_realtime_stale") {
  throw new Error(`unexpected tick status: ${report.report.status}`);
}
if (!Object.is(report.report.bridge.ready, true) || report.report.bridge.status !== "connected") {
  throw new Error(`unexpected bridge status: ${JSON.stringify(report.report.bridge)}`);
}
if (!report.report.tick.monitorRunning || report.report.tick.realtimeRunning) {
  throw new Error(`unexpected tick flags: ${JSON.stringify(report.report.tick)}`);
}
if (!report.report.latestCallback.sourceLogFile.includes("CapitalHftService")) {
  throw new Error("latest callback source log file missing");
}
if (report.report.freshQuoteAvailable) {
  throw new Error(`unexpected freshQuoteAvailable: ${report.report.freshQuoteAvailable}`);
}
await fs.access(report.files.reportPath);
await fs.access(report.files.markdownPath);

const direct = buildTickDiagnostic({
  dashboard,
  quoteStatus,
  latestQuoteEvent,
  serviceState: {
    status: "running",
    pid: 1234,
    watchScript: "D:/OpenClaw/scripts/openclaw-auto-trading-watch.mjs",
    nextSafeTask: "keep running",
  },
  dashboardPath,
  quoteStatusPath,
  latestQuoteEventPath,
  reportPath: report.files.reportPath,
  markdownPath: report.files.markdownPath,
});
if (direct.status !== "monitor_fresh_realtime_stale") {
  throw new Error(`unexpected direct status: ${direct.status}`);
}
if (direct.freshQuoteAvailable) {
  throw new Error(`unexpected direct freshQuoteAvailable: ${direct.freshQuoteAvailable}`);
}

process.stdout.write("AUTO_TRADING_TICK_DIAGNOSTIC_CHECK=OK\n");
