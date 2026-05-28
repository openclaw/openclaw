import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCapitalQuoteState, writeCapitalQuoteState } from "./openclaw-capital-quote-reader.mjs";
import {
  buildCapitalQuoteRuntimeEvent,
  writeCapitalQuoteRuntimeEvent,
} from "./openclaw-capital-quote-runtime-event.mjs";
import { writeCapitalQuoteStatus } from "./openclaw-capital-quote-status.mjs";

function defaultStatusPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-quote-status.json");
}

function defaultReaderStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-quote-state.json");
}

function defaultPumpReportPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-quote-pump-report.json");
}

function defaultEventDir(repoRoot) {
  return path.join(repoRoot, ".openclaw", "runtime-events");
}

function defaultRiskConfigPath(repoRoot) {
  return path.join(repoRoot, "config", "capital-paper-hft-risk-controls.json");
}

function defaultStrategyPath(repoRoot) {
  return path.join(repoRoot, "config", "capital-paper-microstructure-strategy.json");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new Error(
      `Invalid JSON: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}

function bool(value) {
  return value === true;
}

function numberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stringOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function arrayOr(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function resolvePumpTargets(options, strategy) {
  const optionTargetStockNos = arrayOr(options.targetStockNos);
  const optionQuoteAliases = arrayOr(options.quoteAliases);
  const targetStockNo = stringOr(
    options.targetStockNo,
    stringOr(strategy?.targetStockNo, stringOr(strategy?.symbol)),
  );
  const targetStockNos =
    optionTargetStockNos.length > 0
      ? optionTargetStockNos
      : arrayOr(strategy?.targetStockNos, targetStockNo ? [targetStockNo] : []);
  return {
    marketCode: stringOr(
      options.marketCode,
      stringOr(strategy?.marketCode, stringOr(strategy?.symbol)),
    ),
    targetStockNo,
    targetStockNos,
    quoteAliases:
      optionQuoteAliases.length > 0
        ? optionQuoteAliases
        : arrayOr(strategy?.quoteAliases, targetStockNos),
  };
}

function derivePumpStatus(baseStatus, readerState, maxQuoteAgeSeconds) {
  const baseIsPreviousPump = baseStatus?.source === "CapitalHftService quote pump";
  const baseReady =
    baseIsPreviousPump ||
    baseStatus?.ready === true ||
    (baseStatus?.source === "CapitalHftService quote state" &&
      baseStatus?.bridge?.ready === true &&
      baseStatus?.guard?.active !== true);
  const queueCompleted = bool(baseStatus?.completion?.queueCompleted);
  const openClawReady = bool(baseStatus?.completion?.openClawReady);
  const openClawCompleted = bool(baseStatus?.completion?.openClawCompleted);
  const allReadOnlyMonitorsReady = bool(baseStatus?.monitors?.allReadOnlyMonitorsReady);
  const guardActive = bool(baseStatus?.guard?.active);
  const guardLastCode = stringOr(baseStatus?.guard?.lastCode);
  const tradingOpen = readerState?.session?.tradingOpen === true;
  const quoteAgeSeconds = numberOr(readerState?.quoteEventAgeSeconds, Number.POSITIVE_INFINITY);
  const selectedTargetStockNo = stringOr(readerState?.selection?.targetStockNo);
  const rawBid = stringOr(readerState?.quote?.bid);
  const rawAsk = stringOr(readerState?.quote?.ask);
  const bid = Number(rawBid);
  const ask = Number(rawAsk);
  const bidAskUsable =
    Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid;
  const quoteFreshnessStatus =
    Number.isFinite(quoteAgeSeconds) && quoteAgeSeconds <= maxQuoteAgeSeconds ? "fresh" : "stale";
  const readerBridgeReady =
    readerState?.health?.bridgeReady === true || readerState?.health?.overallReady === true;
  const readerCoreReady =
    readerState?.ready === true ||
    (readerState?.quoteProofStatus === "confirmed" &&
      readerBridgeReady &&
      readerState?.health?.brokerActionRequired !== true &&
      !readerState?.health?.currentBlockingCode);
  const blockers = [];
  if (guardActive) {
    blockers.push(guardLastCode === "1115" ? "cooldown_1115" : "guard_active");
  }
  if (!queueCompleted || !openClawReady || !openClawCompleted || !allReadOnlyMonitorsReady) {
    blockers.push("queue_or_monitor_incomplete");
  }
  if (!baseReady || !readerCoreReady) {
    blockers.push("reader_not_ready");
  }
  if (!tradingOpen) {
    blockers.push("session_closed");
  }
  if (quoteFreshnessStatus !== "fresh") {
    blockers.push("freshness_stale");
  }
  if (!bidAskUsable) {
    blockers.push("bid_ask_not_usable");
  }

  let status = "degraded";
  let reason = "群益 quote pump 尚未達到完整 ready 條件。";
  if (guardActive) {
    status = guardLastCode === "1115" ? "blocked_1115" : "blocked";
    reason = "群益 guard/cooldown active；禁止登入、禁止推進 StartIndex。";
  } else if (!queueCompleted || !openClawReady || !openClawCompleted || !allReadOnlyMonitorsReady) {
    status = "incomplete";
    reason = "群益全商品 read-only 報價輪替或 OpenClaw monitor 尚未完成。";
  } else if (quoteFreshnessStatus !== "fresh") {
    status = "stale";
    reason = "CapitalHftService 最新 quote event 未達 HFT freshness gate；不得產生 paper intent。";
  } else if (!baseReady || !readerCoreReady) {
    status = "blocked";
    reason = "CapitalHftService reader 未達 connected/ready；不得把報價交給策略。";
  } else if (!tradingOpen) {
    status = "session_closed";
    reason = "目前不在台指日盤 / 夜盤交易時段；不得產生 paper intent。";
  } else {
    status = "ready";
    reason = "CapitalHftService 最新 quote event 已通過 OpenClaw HFT freshness gate。";
  }

  const strategyReady = status === "ready";
  return {
    schema: "openclaw.capital.quote-status.v1",
    generatedAt: new Date().toISOString(),
    provider: "capital",
    source: "CapitalHftService quote pump",
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    status,
    ready: strategyReady,
    reason,
    strategyGate: {
      ready: strategyReady,
      status: strategyReady ? "allow_read_only_strategy_context" : "deny_strategy_context",
      reason: strategyReady
        ? "HFT freshness gate passed; latest quote event can be used as paper strategy context."
        : reason,
    },
    guard: {
      active: guardActive,
      lastCode: guardLastCode,
      nextAllowedAt: stringOr(baseStatus?.guard?.nextAllowedAt),
    },
    quoteProof: {
      status: stringOr(readerState?.quoteProofStatus, "not_confirmed"),
      freshness: quoteFreshnessStatus,
      latestStock: stringOr(readerState?.quote?.stockNo),
      latestStockName: stringOr(readerState?.quote?.stockName),
      targetStockNo: selectedTargetStockNo,
      freshnessStatus: quoteFreshnessStatus,
      freshnessAgeSeconds: Number.isFinite(quoteAgeSeconds) ? quoteAgeSeconds : -1,
      maxFreshSeconds: maxQuoteAgeSeconds,
      maxAllowedFreshAgeSeconds: maxQuoteAgeSeconds,
    },
    session: {
      marketSession: stringOr(readerState?.session?.marketSession),
      marketSessionLabel: stringOr(readerState?.session?.marketSessionLabel),
      tradingOpen,
    },
    diagnostics: {
      bidAskUsable,
      blockers,
      selectedStock: {
        targetStockNo: selectedTargetStockNo,
        source: stringOr(readerState?.selection?.source),
        matched: readerState?.selection?.matched === true,
        selectedFromEventStream: readerState?.selection?.selectedFromEventStream === true,
        latestOverallStockNo: stringOr(readerState?.selection?.latestOverallStockNo),
        latestOverallReceivedAt: stringOr(readerState?.selection?.latestOverallReceivedAt),
      },
      latestQuote: {
        receivedAt: stringOr(readerState?.quote?.receivedAt),
        eventSource: stringOr(readerState?.quote?.eventSource),
        message: stringOr(readerState?.quote?.message),
        stockNo: stringOr(readerState?.quote?.stockNo),
        stockName: stringOr(readerState?.quote?.stockName),
        close: stringOr(readerState?.quote?.close),
        bid: rawBid,
        ask: rawAsk,
        qty: stringOr(readerState?.quote?.qty),
      },
    },
    completion: {
      queueCompleted,
      openClawReady,
      openClawCompleted,
      lastRunStatus: stringOr(baseStatus?.completion?.lastRunStatus),
      quoteUniverseCount: numberOr(baseStatus?.completion?.quoteUniverseCount, 0),
      distinctQuoteCodeCount: numberOr(baseStatus?.completion?.distinctQuoteCodeCount, 0),
      completionUniverseCount: numberOr(baseStatus?.completion?.completionUniverseCount, 0),
      completionBasis: stringOr(baseStatus?.completion?.completionBasis),
      nextStartIndex: numberOr(baseStatus?.completion?.nextStartIndex, 0),
    },
    monitors: {
      freshnessReady: quoteFreshnessStatus === "fresh",
      mappingReady: bool(baseStatus?.monitors?.mappingReady),
      classificationReady: bool(baseStatus?.monitors?.classificationReady),
      allReadOnlyMonitorsReady,
      mappingFamilies: numberOr(baseStatus?.monitors?.mappingFamilies, 0),
      classificationMappedRows: numberOr(baseStatus?.monitors?.classificationMappedRows, 0),
      classificationDistinctQuoteCodes: numberOr(
        baseStatus?.monitors?.classificationDistinctQuoteCodes,
        0,
      ),
    },
    nextSafeTask:
      status === "ready"
        ? "執行 paper HFT readiness 與 paper trading simulator；仍禁止真實下單。"
        : "等待 CapitalHftService 寫入更新的 quote event；不要登入、不要推進 StartIndex。",
    files: {
      dashboard: stringOr(baseStatus?.files?.dashboard),
      sourceDashboardPath: stringOr(baseStatus?.files?.sourceDashboardPath),
      quoteReaderState: stringOr(readerState?.files?.latestQuoteEvent),
      quoteEvents: stringOr(readerState?.files?.quoteEvents),
    },
  };
}

export async function runCapitalQuotePump(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const riskConfigPath = path.resolve(options.riskConfigPath || defaultRiskConfigPath(repoRoot));
  const strategyPath = path.resolve(options.strategyPath || defaultStrategyPath(repoRoot));
  const riskConfig = (await readJsonIfExists(riskConfigPath)) ?? {};
  const strategy = (await readJsonIfExists(strategyPath)) ?? {};
  const targets = resolvePumpTargets(options, strategy);
  const maxQuoteAgeSeconds = numberOr(
    options.maxQuoteAgeSeconds,
    riskConfig.maxDecisionQuoteAgeSeconds ?? 2,
  );
  const baseStatusPath = path.resolve(options.baseStatusPath || defaultStatusPath(repoRoot));
  const readerStatePath = path.resolve(options.readerStatePath || defaultReaderStatePath(repoRoot));
  const reportPath = path.resolve(options.reportPath || defaultPumpReportPath(repoRoot));
  const eventDir = path.resolve(options.eventDir || defaultEventDir(repoRoot));
  const baseStatus = (await readJsonIfExists(baseStatusPath)) ?? {};
  const readerState = await readCapitalQuoteState({
    stateDir: options.stateDir || undefined,
    targetStockNo: targets.targetStockNo,
    targetStockNos: targets.targetStockNos,
    quoteAliases: targets.quoteAliases,
    marketCode: targets.marketCode,
    marketRegistryPath: options.marketRegistryPath || undefined,
  });
  await writeCapitalQuoteState(readerState, readerStatePath);
  const pumpedStatus = derivePumpStatus(baseStatus, readerState, maxQuoteAgeSeconds);
  await writeCapitalQuoteStatus(pumpedStatus, baseStatusPath);
  const event = buildCapitalQuoteRuntimeEvent(pumpedStatus);
  const eventFiles = await writeCapitalQuoteRuntimeEvent(event, eventDir);
  const report = {
    schema: "openclaw.capital.quote-pump-report.v1",
    generatedAt: new Date().toISOString(),
    status: pumpedStatus.status,
    ready: pumpedStatus.ready,
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    maxQuoteAgeSeconds,
    quote: {
      stockNo: readerState.quote?.stockNo ?? "",
      stockName: readerState.quote?.stockName ?? "",
      targetStockNo: readerState.selection?.targetStockNo ?? "",
      eventSource: readerState.quote?.eventSource ?? "",
      receivedAt: readerState.quote?.receivedAt ?? "",
      ageSeconds: readerState.quoteEventAgeSeconds ?? -1,
      freshness: pumpedStatus.quoteProof.freshnessStatus,
      close: readerState.quote?.close ?? "",
      bid: readerState.quote?.bid ?? "",
      ask: readerState.quote?.ask ?? "",
      qty: readerState.quote?.qty ?? "",
    },
    files: {
      readerStatePath,
      statusPath: baseStatusPath,
      runtimeEventPath: eventFiles.latestPath,
      runtimeEventStreamPath: eventFiles.streamPath,
      riskConfigPath,
      strategyPath,
      reportPath,
    },
    nextSafeTask:
      pumpedStatus.status === "ready"
        ? "執行 pnpm capital-hft:paper-hft:readiness 與 pnpm capital-hft:paper-trade:simulate。"
        : "等待新報價 callback 後重跑 pump；禁止用 stale quote 產生 paper intent。",
  };
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, reportText, "utf8");
  await fs.writeFile(`${reportPath}.sha256`, `${sha256Text(reportText)}\n`, "ascii");
  return { readerState, status: pumpedStatus, event, report };
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    stateDir: "",
    targetStockNo: "",
    targetStockNos: [],
    quoteAliases: [],
    marketCode: "",
    marketRegistryPath: "",
    riskConfigPath: "",
    strategyPath: "",
    baseStatusPath: "",
    readerStatePath: "",
    reportPath: "",
    eventDir: "",
    maxQuoteAgeSeconds: undefined,
    json: false,
    requireReady: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--state-dir") {
      options.stateDir = argv[++index] ?? options.stateDir;
    } else if (arg.startsWith("--state-dir=")) {
      options.stateDir = arg.slice("--state-dir=".length);
    } else if (arg === "--stock-no" || arg === "--target-stock-no") {
      options.targetStockNo = argv[++index] ?? options.targetStockNo;
    } else if (arg.startsWith("--stock-no=")) {
      options.targetStockNo = arg.slice("--stock-no=".length);
    } else if (arg.startsWith("--target-stock-no=")) {
      options.targetStockNo = arg.slice("--target-stock-no=".length);
    } else if (arg === "--target-stock-nos") {
      options.targetStockNos = String(argv[++index] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--target-stock-nos=")) {
      options.targetStockNos = arg
        .slice("--target-stock-nos=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === "--quote-aliases") {
      options.quoteAliases = String(argv[++index] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--quote-aliases=")) {
      options.quoteAliases = arg
        .slice("--quote-aliases=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === "--market-code") {
      options.marketCode = argv[++index] ?? options.marketCode;
    } else if (arg.startsWith("--market-code=")) {
      options.marketCode = arg.slice("--market-code=".length);
    } else if (arg === "--market-registry") {
      options.marketRegistryPath = argv[++index] ?? options.marketRegistryPath;
    } else if (arg.startsWith("--market-registry=")) {
      options.marketRegistryPath = arg.slice("--market-registry=".length);
    } else if (arg === "--risk-config") {
      options.riskConfigPath = argv[++index] ?? options.riskConfigPath;
    } else if (arg.startsWith("--risk-config=")) {
      options.riskConfigPath = arg.slice("--risk-config=".length);
    } else if (arg === "--strategy") {
      options.strategyPath = argv[++index] ?? options.strategyPath;
    } else if (arg.startsWith("--strategy=")) {
      options.strategyPath = arg.slice("--strategy=".length);
    } else if (arg === "--status") {
      options.baseStatusPath = argv[++index] ?? options.baseStatusPath;
    } else if (arg.startsWith("--status=")) {
      options.baseStatusPath = arg.slice("--status=".length);
    } else if (arg === "--reader-state") {
      options.readerStatePath = argv[++index] ?? options.readerStatePath;
    } else if (arg.startsWith("--reader-state=")) {
      options.readerStatePath = arg.slice("--reader-state=".length);
    } else if (arg === "--report") {
      options.reportPath = argv[++index] ?? options.reportPath;
    } else if (arg.startsWith("--report=")) {
      options.reportPath = arg.slice("--report=".length);
    } else if (arg === "--event-dir") {
      options.eventDir = argv[++index] ?? options.eventDir;
    } else if (arg.startsWith("--event-dir=")) {
      options.eventDir = arg.slice("--event-dir=".length);
    } else if (arg === "--max-quote-age-seconds") {
      options.maxQuoteAgeSeconds = Number(argv[++index] ?? "");
    } else if (arg.startsWith("--max-quote-age-seconds=")) {
      options.maxQuoteAgeSeconds = Number(arg.slice("--max-quote-age-seconds=".length));
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--require-ready") {
      options.requireReady = true;
    }
  }
  return options;
}

function formatSummary(result) {
  return [
    "OpenClaw Capital quote pump",
    `status=${result.report.status}`,
    `ready=${result.report.ready}`,
    `stockNo=${result.report.quote.stockNo || "N/A"}`,
    `targetStockNo=${result.report.quote.targetStockNo || "N/A"}`,
    `ageSeconds=${result.report.quote.ageSeconds}`,
    `maxQuoteAgeSeconds=${result.report.maxQuoteAgeSeconds}`,
    `event=${result.report.files.runtimeEventPath}`,
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runCapitalQuotePump(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummary(result)}\n`);
  }
  if (options.requireReady && !result.report.ready) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital quote pump failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
