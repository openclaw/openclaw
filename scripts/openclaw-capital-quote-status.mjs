import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/brokerdesk-state-dir.mjs";
import { readCapitalQuoteState } from "./openclaw-capital-quote-reader.mjs";

function defaultDashboardPath() {
  if (process.env.OPENCLAW_CAPITAL_QUOTE_DASHBOARD_PATH) {
    return process.env.OPENCLAW_CAPITAL_QUOTE_DASHBOARD_PATH;
  }
  if (process.platform === "win32") {
    return "D:\\OpenClaw\\.openclaw\\quote\\capital-automation-health-dashboard.json";
  }
  return path.resolve(".openclaw/quote/capital-automation-health-dashboard.json");
}

function defaultCapitalHftStateDir(preferCanonical = false) {
  return resolveCapitalHftStateDir({ preferCanonical });
}

function defaultMarketRegistryPath() {
  return (
    process.env.OPENCLAW_CAPITAL_MARKET_REGISTRY_PATH ||
    "D:\\OpenClawData\\trading\\global_futures_market_registry.json"
  );
}

function defaultStrategyPath(repoRoot) {
  return path.join(repoRoot, "config", "capital-paper-microstructure-strategy.json");
}

function defaultOutputPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-quote-status.json");
}

function defaultServiceStatusPath(repoRoot) {
  return (
    process.env.OPENCLAW_CAPITAL_SERVICE_STATUS_PATH ||
    path.join(repoRoot, ".openclaw", "quote", "capital-service-status.json")
  );
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readJson(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR" || error?.code === "ENOTDIR") {
      return null;
    }
    throw new Error(
      `Invalid Capital quote dashboard JSON: ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR" || error?.code === "ENOTDIR") {
      return null;
    }
    throw error;
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

function parseTimestampMs(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) {
    return direct;
  }
  const normalized = value.replace(/(\.\d{3})\d+([Z+-])/u, "$1$2");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageSecondsSince(value, now = new Date()) {
  const timestampMs = parseTimestampMs(value);
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  return Math.max(0, Math.round((now.getTime() - timestampMs) / 1000));
}

function normalizeMarketCode(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizeStockNo(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

const LEGACY_ACTIVE_QUOTE_SYMBOLS = new Map([
  ["TX00AM", "TX00"],
  ["TX00PM", "TX00"],
  ["TX06AM", "TX06"],
  ["TX06PM", "TX06"],
]);

function canonicalQuoteSymbol(value) {
  const normalized = normalizeStockNo(value);
  return LEGACY_ACTIVE_QUOTE_SYMBOLS.get(normalized) ?? normalized;
}

function sanitizeLegacyActiveSymbolsInString(value) {
  let sanitized = typeof value === "string" ? value : "";
  for (const [legacy, canonical] of LEGACY_ACTIVE_QUOTE_SYMBOLS.entries()) {
    sanitized = sanitized.replaceAll(legacy, canonical);
  }
  return sanitized;
}

function normalizeTargetStockNos(values) {
  const seen = new Set();
  const normalized = [];
  for (const value of Array.isArray(values) ? values : []) {
    const candidate = canonicalQuoteSymbol(value);
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
}

function sanitizeQuote(quote = {}) {
  if (!quote || typeof quote !== "object") {
    return {
      receivedAt: "",
      eventSource: "",
      stockNo: "",
      stockName: "",
      close: "",
      bid: "",
      ask: "",
      qty: "",
      message: "",
    };
  }
  return {
    ...quote,
    stockNo: canonicalQuoteSymbol(quote.stockNo),
    message: sanitizeLegacyActiveSymbolsInString(quote.message),
  };
}

function sanitizeSelectedStock(selection = {}) {
  const base = selection && typeof selection === "object" ? selection : {};
  return {
    ...base,
    targetStockNo: canonicalQuoteSymbol(base.targetStockNo),
    targetStockNos: normalizeTargetStockNos(base.targetStockNos),
    quoteAliases: normalizeTargetStockNos(base.quoteAliases),
    latestOverallStockNo: canonicalQuoteSymbol(base.latestOverallStockNo),
  };
}

function serviceStatusUsable(serviceStatus, options = {}) {
  if (serviceStatus?.schema !== "openclaw.capital.service-status.v1") {
    return false;
  }
  const maxAgeSeconds = numberOr(options.serviceStatusMaxAgeSeconds, 300);
  const ageSeconds = ageSecondsSince(serviceStatus.generatedAt, options.now ?? new Date());
  if (!Number.isFinite(ageSeconds) || ageSeconds > maxAgeSeconds) {
    return false;
  }
  if (serviceStatus?.service?.statusFresh === false) {
    return false;
  }
  return true;
}

function normalizeServiceStatusAsQuoteStatus(serviceStatus, options = {}) {
  const quote = serviceStatus?.quote ?? {};
  const quoteReady =
    serviceStatus?.ready === true &&
    quote.ready === true &&
    serviceStatus?.safety?.staleQuoteReturned !== true;
  const quoteStatus = quoteReady
    ? "ready"
    : quote.status === "session_closed"
      ? "session_closed"
      : quote.status === "fresh"
        ? "stale"
        : stringOr(quote.status, "blocked");
  const freshnessStatus = quoteReady
    ? "fresh"
    : quoteStatus === "session_closed"
      ? "session_closed"
      : stringOr(quote.freshnessStatus, quoteStatus === "blocked" ? "blocked" : "stale");
  const reason = quoteReady
    ? stringOr(quote.reason, "CapitalHftService service-status confirmed fresh quote.")
    : stringOr(
        quote.reason,
        serviceStatus?.blockerCode || "CapitalHftService service-status blocked quote.",
      );
  const matrixSummary = quote.matrixSummary ?? {};
  const serviceStatusPath = stringOr(
    options.serviceStatusPath,
    defaultServiceStatusPath(path.resolve(options.repoRoot ?? process.cwd())),
  );

  return {
    schema: "openclaw.capital.quote-status.v1",
    generatedAt: new Date().toISOString(),
    provider: "capital",
    source: "CapitalHftService service status",
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    status: quoteStatus,
    ready: quoteReady,
    reason,
    strategyGate: {
      ready: quoteReady,
      status: quoteReady ? "allow_read_only_strategy_context" : "deny_strategy_context",
      reason,
    },
    guard: {
      active: false,
      lastCode: stringOr(serviceStatus?.blockerCode, ""),
      nextAllowedAt: "",
    },
    bridge: {
      status: stringOr(serviceStatus?.service?.status, "unknown"),
      ready: serviceStatus?.service?.ready === true,
      overallReady: serviceStatus?.ready === true,
      quoteEventConfirmed: quoteReady,
      lastHeartbeatAt: stringOr(serviceStatus?.service?.statusGeneratedAt, ""),
      keepAliveUntil: "",
      brokerActionRequired: !quoteReady,
      currentBlockingCode: stringOr(serviceStatus?.blockerCode, ""),
      capitalAccountSet: serviceStatus?.positionQuery?.accountCount > 0,
      capitalAttempted: false,
      capitalMessage: stringOr(serviceStatus?.service?.loginStatus, ""),
      lastLogin1115Historical: false,
    },
    quoteProof: {
      status: quoteReady ? "confirmed" : "blocked",
      freshness: freshnessStatus,
      latestStock: "",
      latestStockName: "",
      freshnessStatus,
      freshnessAgeSeconds: numberOr(
        quote.freshnessAgeSeconds,
        numberOr(serviceStatus?.service?.statusAgeSeconds, -1),
      ),
      maxFreshSeconds: numberOr(quote.maxFreshSeconds, 300),
      maxAllowedFreshAgeSeconds: numberOr(quote.maxAllowedFreshAgeSeconds, 300),
    },
    completion: {
      queueCompleted: quoteReady,
      openClawReady: serviceStatus?.ready === true,
      openClawCompleted: serviceStatus?.ready === true,
      lastRunStatus: stringOr(serviceStatus?.status, ""),
      quoteUniverseCount: numberOr(matrixSummary.productCount, 0),
      distinctQuoteCodeCount: numberOr(matrixSummary.freshCount, 0),
      completionUniverseCount: numberOr(matrixSummary.requiredCount, 0),
      completionBasis: "capital_service_status",
      nextStartIndex: 0,
    },
    monitors: {
      freshnessReady: quoteReady,
      mappingReady: true,
      classificationReady: true,
      allReadOnlyMonitorsReady: quoteReady,
      mappingFamilies: numberOr(matrixSummary.productCount, 0),
      classificationMappedRows:
        numberOr(matrixSummary.subscribedDomesticCount, 0) +
        numberOr(matrixSummary.subscribedOverseasCount, 0),
      classificationDistinctQuoteCodes: numberOr(matrixSummary.productCount, 0),
    },
    nextSafeTask: stringOr(serviceStatus?.nextSafeTask, "依 service-status 下一步執行。"),
    files: {
      dashboard: "",
      sourceDashboardPath: "",
      sourceStateDir: stringOr(serviceStatus?.capitalRoot, ""),
      serviceStatus: serviceStatusPath,
      freshnessState: "",
      productMappingState: "",
      domesticOverseasState: "",
      latestQuoteEvent: "",
      quoteEvents: "",
    },
    session: {
      marketSession: quoteStatus === "session_closed" ? "closed" : "unknown",
      marketSessionLabel: quoteStatus === "session_closed" ? "休市" : "未知",
      tradingOpen: quoteStatus !== "session_closed",
    },
    quote: {
      receivedAt: stringOr(serviceStatus?.service?.statusGeneratedAt, ""),
      eventSource: "capital_service_status",
      stockNo: "",
      stockName: "",
      close: "",
      bid: "",
      ask: "",
      qty: "",
      message: stringOr(serviceStatus?.replyLine, ""),
    },
    diagnostics: {
      selectedStock: {
        targetStockNo: "",
        targetStockNos: [],
        marketCode: "",
        source: "capital_service_status",
        matched: quoteReady,
        selectedFromEventStream: false,
        latestOverallStockNo: "",
        latestOverallReceivedAt: stringOr(serviceStatus?.service?.statusGeneratedAt, ""),
      },
      latestQuote: {},
      bidAskUsable: quoteReady,
      blockers: Array.isArray(serviceStatus?.failedSteps) ? serviceStatus.failedSteps : [],
      serviceStatus: {
        status: stringOr(serviceStatus?.status, ""),
        blockerCode: stringOr(serviceStatus?.blockerCode, ""),
        failedSteps: Array.isArray(serviceStatus?.failedSteps) ? serviceStatus.failedSteps : [],
        quoteStatus: stringOr(quote.status, ""),
        strictGateSource: stringOr(quote.strictGateSource, ""),
      },
    },
  };
}

export function normalizeCapitalQuoteDashboard(dashboard, quoteState = null, options = {}) {
  const guardActive = bool(dashboard?.guard?.active ?? quoteState?.health?.brokerActionRequired);
  const queueCompleted = bool(
    dashboard?.readiness?.queueCompleted ?? dashboard?.capitalHftQueue?.completed,
  );
  const openClawReady = bool(
    dashboard?.readiness?.openClawReady ?? dashboard?.openClawQueue?.ready,
  );
  const openClawCompleted = bool(
    dashboard?.readiness?.openClawCompleted ?? dashboard?.openClawQueue?.completed,
  );
  const freshnessReady = bool(dashboard?.readiness?.freshnessReady);
  const mappingReady = bool(dashboard?.readiness?.mappingReady);
  const classificationReady = bool(dashboard?.readiness?.classificationReady);
  const allReadOnlyMonitorsReady = bool(dashboard?.readiness?.allReadOnlyMonitorsReady);
  const freshnessStatus = stringOr(
    quoteState?.quoteEventFreshness,
    stringOr(dashboard?.quoteFreshness?.status, ""),
  );
  const freshnessAgeSeconds = numberOr(
    quoteState?.quoteEventAgeSeconds,
    numberOr(dashboard?.quoteFreshness?.ageSeconds, -1),
  );
  const maxFreshSeconds = numberOr(
    quoteState?.quoteEventFreshnessThresholdSeconds,
    numberOr(dashboard?.quoteFreshness?.maxFreshSeconds, 0),
  );
  const maxAllowedFreshAgeSeconds = numberOr(options.maxFreshAgeSeconds, maxFreshSeconds);
  const quoteProofStatus = stringOr(
    quoteState?.quoteProofStatus,
    stringOr(dashboard?.capitalHftQueue?.quoteProofStatus, ""),
  );
  const quoteProofFreshness = stringOr(
    quoteState?.quoteEventFreshness,
    stringOr(dashboard?.capitalHftQueue?.quoteProofFreshness, ""),
  );
  const lastCode = stringOr(dashboard?.guard?.lastCode, quoteState?.health?.currentBlockingCode);
  const lastRunStatus = stringOr(dashboard?.capitalHftQueue?.lastRunStatus, "");
  const quote = sanitizeQuote(quoteState?.quote);
  const selectedStock = sanitizeSelectedStock(quoteState?.selection);
  const latestStock = canonicalQuoteSymbol(
    stringOr(quote.stockNo, stringOr(dashboard?.quoteFreshness?.latestStock, "")),
  );
  const latestStockName = stringOr(
    quote.stockName,
    stringOr(dashboard?.quoteFreshness?.latestStockName, ""),
  );
  const bridgeReady = bool(quoteState?.health?.bridgeReady);
  const quoteReady = quoteState?.ready === true;
  const sessionClosed =
    quoteState?.session?.tradingOpen === false || quoteState?.session?.marketSession === "closed";

  let status = "degraded";
  let reason = "群益報價 dashboard 尚未達到完整 ready 條件。";
  if (guardActive || dashboard?.healthStatus === "cooldown") {
    status = lastCode === "1115" ? "blocked_1115" : "blocked";
    reason = "群益登入 guard/cooldown active；OpenClaw 不得登入或推進 StartIndex。";
  } else if (!queueCompleted) {
    status = "incomplete";
    reason = "群益全商品 read-only 報價輪替尚未完成。";
  } else if (freshnessStatus === "stale" || freshnessAgeSeconds > maxAllowedFreshAgeSeconds) {
    status = sessionClosed ? "session_closed" : "stale";
    reason = sessionClosed
      ? "目前為休市；最新報價超過 freshness gate，僅可作歷史/狀態回報，不可作策略即時上下文。"
      : "最新報價證明已超過 freshness gate；策略不得使用舊報價。";
  } else if (allReadOnlyMonitorsReady) {
    status = quoteReady && freshnessStatus === "fresh" ? "ready" : "stale";
    reason =
      status === "ready"
        ? "群益 read-only 報價、freshness、mapping、分類與 OpenClaw 狀態皆 ready。"
        : !bridgeReady
          ? "CapitalHftService bridge 尚未 connected 或 overallReady=false。"
          : "CapitalHftService quote state 尚未通過即時 freshness gate。";
  }

  const strategyGateReady =
    status === "ready" && freshnessStatus === "fresh" && quoteReady && bridgeReady;

  return {
    schema: "openclaw.capital.quote-status.v1",
    generatedAt: new Date().toISOString(),
    provider: "capital",
    source:
      quoteState?.source === "CapitalHftService"
        ? "CapitalHftService quote state"
        : quoteState
          ? "CapitalHftService quote state"
          : "CapitalHftService health dashboard",
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    status,
    ready: status === "ready",
    reason,
    strategyGate: {
      ready: strategyGateReady,
      status: strategyGateReady ? "allow_read_only_strategy_context" : "deny_strategy_context",
      reason: strategyGateReady
        ? "freshness gate passed; quote state can be used as read-only strategy context."
        : reason,
    },
    guard: {
      active: guardActive,
      lastCode,
      nextAllowedAt: stringOr(dashboard?.guard?.nextAllowedAt, ""),
    },
    bridge: {
      status: stringOr(quoteState?.health?.bridgeStatus, stringOr(dashboard?.healthStatus, "")),
      ready: bridgeReady,
      overallReady: bool(quoteState?.health?.overallReady),
      quoteEventConfirmed: bool(quoteState?.health?.quoteEventConfirmed),
      lastHeartbeatAt: stringOr(quoteState?.health?.lastHeartbeatAt, ""),
      keepAliveUntil: stringOr(quoteState?.health?.keepAliveUntil, ""),
      brokerActionRequired: bool(
        quoteState?.health?.brokerActionRequired ?? dashboard?.guard?.active,
      ),
      currentBlockingCode: stringOr(
        quoteState?.health?.currentBlockingCode,
        stringOr(dashboard?.guard?.lastCode, ""),
      ),
      capitalAccountSet: bool(quoteState?.health?.capitalAccountSet),
      capitalAttempted: bool(quoteState?.health?.capitalAttempted),
      capitalMessage: stringOr(quoteState?.health?.capitalMessage, ""),
      lastLogin1115Historical: bool(
        quoteState?.health?.lastLogin1115Historical ?? dashboard?.health?.lastLogin1115Historical,
      ),
    },
    quoteProof: {
      status: quoteProofStatus,
      freshness: quoteProofFreshness,
      latestStock,
      latestStockName,
      freshnessStatus,
      freshnessAgeSeconds,
      maxFreshSeconds,
      maxAllowedFreshAgeSeconds,
    },
    completion: {
      queueCompleted,
      openClawReady,
      openClawCompleted,
      lastRunStatus,
      quoteUniverseCount: numberOr(dashboard?.capitalHftQueue?.quoteUniverseCount, 0),
      distinctQuoteCodeCount: numberOr(dashboard?.capitalHftQueue?.distinctQuoteCodeCount, 0),
      completionUniverseCount: numberOr(dashboard?.capitalHftQueue?.completionUniverseCount, 0),
      completionBasis: stringOr(dashboard?.capitalHftQueue?.completionBasis, ""),
      nextStartIndex: numberOr(dashboard?.capitalHftQueue?.nextStartIndex, 0),
    },
    monitors: {
      freshnessReady,
      mappingReady,
      classificationReady,
      allReadOnlyMonitorsReady,
      mappingFamilies: numberOr(dashboard?.productMapping?.productFamilyRows, 0),
      classificationMappedRows: numberOr(
        dashboard?.domesticOverseasClassification?.mappingAppliedRows,
        0,
      ),
      classificationDistinctQuoteCodes: numberOr(
        dashboard?.domesticOverseasClassification?.distinctQuoteCodes,
        0,
      ),
    },
    nextSafeTask: stringOr(dashboard?.nextSafeTask, ""),
    files: {
      dashboard: stringOr(dashboard?.latestReports?.healthDashboard, ""),
      sourceDashboardPath: stringOr(options.dashboardPath, defaultDashboardPath()),
      sourceStateDir: stringOr(quoteState?.sourceStateDir, ""),
      freshnessState: stringOr(dashboard?.quoteFreshness?.path, ""),
      productMappingState: stringOr(dashboard?.productMapping?.path, ""),
      domesticOverseasState: stringOr(dashboard?.domesticOverseasClassification?.path, ""),
      latestQuoteEvent: stringOr(quoteState?.files?.latestQuoteEvent, ""),
      quoteEvents: stringOr(quoteState?.files?.quoteEvents, ""),
    },
    session: quoteState?.session ?? {
      marketSession: "",
      marketSessionLabel: "",
      tradingOpen: false,
    },
    quote: quoteState
      ? quote
      : {
          receivedAt: "",
          eventSource: "",
          stockNo: "",
          stockName: "",
          close: "",
          bid: "",
          ask: "",
          qty: "",
          message: "",
        },
    diagnostics: {
      selectedStock: quoteState
        ? selectedStock
        : {
            targetStockNo: "",
            targetStockNos: [],
            quoteAliases: [],
            marketCode: "",
            source: "",
            matched: false,
            selectedFromEventStream: false,
            latestOverallStockNo: "",
            latestOverallReceivedAt: "",
          },
      latestQuote: quoteState ? quote : {},
      bidAskUsable: quoteReady,
    },
  };
}

export async function readCapitalQuoteStatus(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  if (options.preferServiceStatus === true) {
    const serviceStatusPath = path.resolve(
      options.serviceStatusPath || defaultServiceStatusPath(repoRoot),
    );
    const serviceStatus = await readJsonIfExists(serviceStatusPath);
    if (serviceStatusUsable(serviceStatus, options)) {
      return normalizeServiceStatusAsQuoteStatus(serviceStatus, {
        ...options,
        repoRoot,
        serviceStatusPath,
      });
    }
  }
  const dashboardPath = path.resolve(
    typeof options.dashboardPath === "string" && options.dashboardPath.trim().length > 0
      ? options.dashboardPath
      : defaultDashboardPath(),
  );
  const dashboard = (await readJson(dashboardPath)) ?? {};
  const strategyPath = path.resolve(
    typeof options.strategyPath === "string" && options.strategyPath.trim().length > 0
      ? options.strategyPath
      : defaultStrategyPath(repoRoot),
  );
  const strategy = await readJsonIfExists(strategyPath);
  const optionMarketCode = normalizeMarketCode(options.marketCode);
  const strategyMarketCode = normalizeMarketCode(
    stringOr(strategy?.marketCode, stringOr(strategy?.symbol, "")),
  );
  const useStrategyTargets = !optionMarketCode || optionMarketCode === strategyMarketCode;
  const resolvedMarketCode = optionMarketCode || strategyMarketCode;
  const resolvedTargetStockNo = (() => {
    const optionTargetStockNo = canonicalQuoteSymbol(options.targetStockNo);
    if (optionTargetStockNo) {
      return optionTargetStockNo;
    }
    if (!useStrategyTargets) {
      return "";
    }
    return canonicalQuoteSymbol(stringOr(strategy?.targetStockNo, stringOr(strategy?.symbol, "")));
  })();
  const resolvedTargetStockNos = (() => {
    const optionTargets = Array.isArray(options.targetStockNos)
      ? normalizeTargetStockNos(options.targetStockNos)
      : [];
    if (optionTargets.length > 0) {
      return optionTargets;
    }
    if (
      useStrategyTargets &&
      Array.isArray(strategy?.targetStockNos) &&
      strategy.targetStockNos.length > 0
    ) {
      return normalizeTargetStockNos(strategy.targetStockNos);
    }
    return resolvedTargetStockNo ? [resolvedTargetStockNo] : [];
  })();
  const resolvedQuoteAliases = (() => {
    const optionAliases = Array.isArray(options.quoteAliases)
      ? normalizeTargetStockNos(options.quoteAliases)
      : [];
    if (optionAliases.length > 0) {
      return optionAliases;
    }
    if (
      useStrategyTargets &&
      Array.isArray(strategy?.quoteAliases) &&
      strategy.quoteAliases.length > 0
    ) {
      return normalizeTargetStockNos(strategy.quoteAliases);
    }
    return resolvedTargetStockNos;
  })();
  const stateDir = path.resolve(
    typeof options.stateDir === "string" && options.stateDir.trim().length > 0
      ? options.stateDir
      : defaultCapitalHftStateDir(resolvedMarketCode === "A50"),
  );
  const quoteState = await readCapitalQuoteState({
    repoRoot,
    stateDir,
    targetStockNo: resolvedTargetStockNo,
    targetStockNos: resolvedTargetStockNos,
    quoteAliases: resolvedQuoteAliases,
    marketCode: resolvedMarketCode,
    marketRegistryPath: options.marketRegistryPath ?? defaultMarketRegistryPath(),
  });
  return normalizeCapitalQuoteDashboard(dashboard, quoteState, {
    ...options,
    dashboardPath,
    strategyPath,
    stateDir,
    marketCode: resolvedMarketCode,
    targetStockNo: resolvedTargetStockNo,
    targetStockNos: resolvedTargetStockNos,
    quoteAliases: resolvedQuoteAliases,
  });
}

export async function writeCapitalQuoteStatus(status, outputPath) {
  const text = `${JSON.stringify(status, null, 2)}\n`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, text, "utf8");
  await fs.writeFile(`${outputPath}.sha256`, `${sha256Text(text)}\n`, "ascii");
  return outputPath;
}

function parseArgs(argv) {
  const options = {
    dashboardPath: defaultDashboardPath(),
    repoRoot: process.cwd(),
    stateDir: "",
    strategyPath: "",
    output: "",
    writeState: false,
    json: false,
    requireReady: false,
    maxFreshAgeSeconds: undefined,
    targetStockNo: "",
    targetStockNos: [],
    quoteAliases: [],
    marketCode: "",
    marketRegistryPath: defaultMarketRegistryPath(),
    preferServiceStatus: true,
    serviceStatusPath: "",
    serviceStatusMaxAgeSeconds: 300,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dashboard") {
      options.dashboardPath = argv[++index] ?? options.dashboardPath;
    } else if (arg.startsWith("--dashboard=")) {
      options.dashboardPath = arg.slice("--dashboard=".length);
    } else if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--state-dir") {
      options.stateDir = argv[++index] ?? options.stateDir;
    } else if (arg.startsWith("--state-dir=")) {
      options.stateDir = arg.slice("--state-dir=".length);
    } else if (arg === "--strategy") {
      options.strategyPath = argv[++index] ?? options.strategyPath;
    } else if (arg.startsWith("--strategy=")) {
      options.strategyPath = arg.slice("--strategy=".length);
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
    } else if (arg === "--service-status") {
      options.serviceStatusPath = argv[++index] ?? options.serviceStatusPath;
    } else if (arg.startsWith("--service-status=")) {
      options.serviceStatusPath = arg.slice("--service-status=".length);
    } else if (arg === "--no-service-status") {
      options.preferServiceStatus = false;
    } else if (arg === "--output") {
      options.output = argv[++index] ?? options.output;
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--require-ready") {
      options.requireReady = true;
    } else if (arg === "--max-fresh-age-seconds") {
      options.maxFreshAgeSeconds = Number(argv[++index] ?? "");
    } else if (arg.startsWith("--max-fresh-age-seconds=")) {
      options.maxFreshAgeSeconds = Number(arg.slice("--max-fresh-age-seconds=".length));
    } else if (arg === "--service-status-max-age-seconds") {
      options.serviceStatusMaxAgeSeconds = Number(argv[++index] ?? "");
    } else if (arg.startsWith("--service-status-max-age-seconds=")) {
      options.serviceStatusMaxAgeSeconds = Number(
        arg.slice("--service-status-max-age-seconds=".length),
      );
    }
  }
  return options;
}

export function formatSummary(status, outputPath) {
  return [
    "OpenClaw Capital quote status",
    `status=${status.status}`,
    `ready=${status.ready}`,
    `bridge=${status.bridge?.status || "N/A"}${status.bridge?.ready ? ":ready" : ""}${status.bridge?.overallReady === true ? ":overall" : ""}${status.bridge?.quoteEventConfirmed === true ? ":confirmed" : ""}`,
    `heartbeatAt=${status.bridge?.lastHeartbeatAt || "N/A"}`,
    `keepAliveUntil=${status.bridge?.keepAliveUntil || "N/A"}`,
    `strategyGate=${status.strategyGate.status}`,
    `quoteProof=${status.quoteProof.status}/${status.quoteProof.freshness}`,
    `freshness=${status.quoteProof.freshnessStatus}`,
    `age=${status.quoteProof.freshnessAgeSeconds}`,
    `freshQuote=${status.quoteProof.freshnessStatus === "fresh" ? "yes" : "no"}`,
    `currentQuote=${status.quoteProof.freshnessStatus === "fresh" ? status.quoteProof.latestStock || "N/A" : "NONE"}`,
    `latestQuote=${status.quoteProof.latestStock || "N/A"}`,
    `session=${status.session?.marketSessionLabel || "N/A"}`,
    `receivedAt=${status.quote?.receivedAt || "N/A"}`,
    outputPath ? `stateFile=${outputPath}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const status = await readCapitalQuoteStatus(options);
  const outputPath = options.writeState
    ? await writeCapitalQuoteStatus(
        status,
        path.resolve(options.output || defaultOutputPath(path.resolve(options.repoRoot))),
      )
    : "";

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...status, outputPath }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummary(status, outputPath)}\n`);
  }

  if (options.requireReady && !status.ready) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital quote status failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
