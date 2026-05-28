import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/brokerdesk-state-dir.mjs";
import { buildCapitalContractMonthRouter } from "./openclaw-capital-contract-month-router.mjs";

const OFFICIAL_CAPITAL_QUOTE_EVENTS = new Set([
  "SKQuoteLib.OnNotifyQuote",
  "SKQuoteLib.OnNotifyTicks",
  "SKQuoteLib.OnNotifyBest5",
  "SKQuoteLib.OnNotifyQuoteLONG",
  "SKQuoteLib.OnNotifyTicksLONG",
  "SKQuoteLib.OnNotifyBest5LONG",
  "SKOSQuoteLib.OnNotifyQuote",
  "SKOSQuoteLib.OnNotifyTicks",
  "SKOSQuoteLib.OnNotifyBest5",
  "SKOSQuoteLib.OnNotifyQuoteLONG",
  "SKOSQuoteLib.OnNotifyTicksLONG",
  "SKOSQuoteLib.OnNotifyBest5LONG",
]);

const DEFAULT_QUOTE_FRESHNESS_SECONDS = 30;
const DEFAULT_MARKET_REGISTRY_PATH =
  "D:\\OpenClawData\\trading\\global_futures_market_registry.json";
const CANONICAL_ONLY_MARKET_HINTS = new Set(["A50", "A50指熱2605", "CN0000"]);
const FALLBACK_MARKET_PROFILES = {
  A50: {
    marketCode: "A50",
    runtimeSymbol: "CN0000",
    productName: "A50指熱2605",
    venue: "SGX",
    assetClass: "equity index futures",
    quoteAdapter: "qyapi_x64",
    executionAdapter: "qyapi_x64",
    paperExecutable: true,
    liveExecutable: false,
    status: "paper_routable",
    notePath: "D:\\OpenClawData\\memory\\TRADE_LOGIC\\MARKET_PROFILE_A50.md",
    quoteAliases: ["A50", "A50指熱2605", "CN0000"],
    blockers: ["live_disabled"],
  },
};
const QYAPI_QUOTE_ALIASES_BY_MARKET_CODE = {
  A50: ["CN0000"],
  BZ: ["BZ0000"],
  CL: ["CL0000", "QM0000", "MCL0000"],
  MCL: ["MCL0000", "CL0000", "QM0000"],
  QM: ["QM0000", "CL0000", "MCL0000"],
  TXF: ["TX00", "TX00AM", "TX00PM", "TXFR1"],
  TX06: ["TX06", "TX06AM", "TX06PM"],
};
const QYAPI_OS_QUOTE_ALIASES_BY_INSTRUMENT = {
  "1OZ": ["1OZ0000"],
  "6A": ["AD0000", "M6A0000"],
  "6B": ["BP0000", "M6B0000"],
  "6C": ["CD0000", "MCD0000"],
  "6E": ["EC0000", "E70000", "M6E0000"],
  "6J": ["JY0000", "J70000"],
  "6M": ["MP0000"],
  "6S": ["SF0000"],
  A50: ["CN0000"],
  AD: ["AD0000", "M6A0000"],
  BP: ["BP0000", "M6B0000"],
  BZ: ["BZ0000"],
  C: ["C0000"],
  CC: ["CC0000"],
  CD: ["CD0000", "MCD0000"],
  CL: ["CL0000", "QM0000", "MCL0000"],
  CN: ["CN0000"],
  CT: ["CT0000"],
  DAX: ["DAX0000"],
  DX: ["DX0000", "DXS0000"],
  E7: ["E70000", "EC0000", "M6E0000"],
  EC: ["EC0000", "E70000", "M6E0000"],
  ES: ["ES0000", "MES0000"],
  ESB: ["ESB0000"],
  ESX: ["ESX0000"],
  FBTP: ["FBTP0000"],
  FC: ["FC0000"],
  FESB: ["ESB0000"],
  FESX: ["ESX0000"],
  FF: ["FF0000"],
  FGBL: ["FGBL0000"],
  FGBM: ["FGBM0000"],
  FGBS: ["FGBS0000"],
  FGBX: ["FGBX0000"],
  FOAT: ["FOAT0000"],
  FV: ["FV0000"],
  GC: ["GC0000", "MGC0000", "1OZ0000"],
  GF: ["FC0000"],
  HG: ["HG0000", "MHG0000"],
  HHI: ["HHI0000", "MCH0000"],
  HO: ["HO0000"],
  HSI: ["HSI0000", "MHI0000"],
  J7: ["J70000", "JY0000"],
  JAM: ["JAM0000"],
  JAU: ["JAU0000"],
  JGB: ["JGB0000"],
  KC: ["KC0000"],
  KS: ["KS0000", "MKS0000"],
  LC: ["LC0000"],
  LE: ["LC0000"],
  LH: ["LH0000"],
  M2K: ["M2K0000", "RTY0000"],
  M6A: ["M6A0000", "AD0000"],
  M6B: ["M6B0000", "BP0000"],
  M6E: ["M6E0000", "EC0000", "E70000"],
  MCD: ["MCD0000", "CD0000"],
  MCH: ["MCH0000", "HHI0000"],
  MCL: ["MCL0000", "CL0000", "QM0000"],
  MES: ["MES0000", "ES0000"],
  MGC: ["MGC0000", "GC0000", "1OZ0000"],
  MHG: ["MHG0000", "HG0000"],
  MHI: ["MHI0000", "HSI0000"],
  MKS: ["MKS0000", "KS0000"],
  MNQ: ["MNQ0000", "NQ0000"],
  MNG: ["MNG0000", "NG0000", "QG0000"],
  MNIK: ["MNIK0000", "NK0000"],
  MTWN: ["MTWN0000", "TWN0000"],
  MYM: ["MYM0000", "YM0000"],
  NG: ["NG0000", "MNG0000", "QG0000"],
  NK: ["NK0000", "MNIK0000"],
  NQ: ["NQ0000", "MNQ0000"],
  O: ["O0000"],
  OJ: ["OJF0000"],
  PA: ["PA0000"],
  PL: ["PL0000", "PLT0000"],
  PLT: ["PLT0000", "PL0000"],
  QG: ["QG0000", "NG0000", "MNG0000"],
  QM: ["QM0000", "CL0000", "MCL0000"],
  RB: ["RB0000"],
  RP: ["RP0000"],
  RTY: ["RTY0000", "M2K0000"],
  RY: ["RY0000"],
  S: ["S0000"],
  SB: ["SB0000"],
  SF: ["SF0000"],
  SG: ["SG0000"],
  SI: ["SI0000", "SIL0000"],
  SIL: ["SIL0000", "SI0000"],
  SM: ["SM0000"],
  SR1: ["SR10000"],
  SR3: ["SR30000"],
  SSI: ["SSI0000"],
  TN: ["TN0000"],
  TU: ["TU0000"],
  TWN: ["TWN0000", "MTWN0000"],
  TY: ["TY0000"],
  UB: ["UB0000"],
  US: ["US0000"],
  VX: ["VX0000", "VXM0000"],
  VXM: ["VXM0000", "VX0000"],
  W: ["W0000"],
  XAE: ["XAE0000"],
  XAF: ["XAF0000"],
  XAI: ["XAI0000"],
  XAP: ["XAP0000"],
  XAU: ["XAU0000"],
  XAV: ["XAV0000"],
  YM: ["YM0000", "MYM0000"],
};

function defaultCapitalHftStateDir(preferCanonical = false) {
  return resolveCapitalHftStateDir({ preferCanonical });
}

function quoteFreshnessThresholdSeconds() {
  const configured = Number(process.env.OPENCLAW_CAPITAL_QUOTE_FRESH_SECONDS ?? "");
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_QUOTE_FRESHNESS_SECONDS;
}

function defaultMarketRegistryPath() {
  return process.env.OPENCLAW_CAPITAL_MARKET_REGISTRY_PATH || DEFAULT_MARKET_REGISTRY_PATH;
}

function repoStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-quote-state.json");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readJsonIfExists(filePath) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const text = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
      if (text.trim().length === 0) {
        throw new SyntaxError("empty JSON content");
      }
      return JSON.parse(text);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      const transientPartialWrite =
        message.includes("Unexpected end of JSON input") ||
        message.includes("Unterminated string") ||
        message.includes("Unexpected end of data") ||
        message.includes("empty JSON content");
      if (transientPartialWrite && attempt < maxAttempts) {
        await new Promise((resolve) => {
          setTimeout(resolve, 40 * attempt);
        });
        continue;
      }
      if (transientPartialWrite) {
        return null;
      }
      throw new Error(`Invalid JSON: ${filePath}: ${message}`, {
        cause: error,
      });
    }
  }
}

async function fileHashIfExists(filePath) {
  try {
    const content = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(content).digest("hex").toUpperCase();
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function countJsonlLines(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function normalizeBool(value) {
  return value === true;
}
function stringOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function parseCapitalHftTimestamp(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(
    value.trim(),
  );
  if (match) {
    const [, year, month, day, hour, minute, second, millisecond = "0"] = match;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(millisecond.padEnd(3, "0")),
    );
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function quoteEventAgeSeconds(receivedAt) {
  const received = parseCapitalHftTimestamp(receivedAt);
  if (!received) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - received.getTime()) / 1000));
}

function deriveTaipeiMarketSession(date = new Date()) {
  const taipeiNow = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const totalMinutes = taipeiNow.getUTCHours() * 60 + taipeiNow.getUTCMinutes();
  if (totalMinutes >= 15 * 60 || totalMinutes < 5 * 60) {
    return { marketSession: "night", marketSessionLabel: "夜盤", tradingOpen: true };
  }
  if (totalMinutes >= 8 * 60 + 45 && totalMinutes < 13 * 60 + 45) {
    return { marketSession: "day", marketSessionLabel: "日盤", tradingOpen: true };
  }
  return { marketSession: "closed", marketSessionLabel: "休市", tradingOpen: false };
}

function normalizeHftServiceState(hftStatus) {
  if (!hftStatus || typeof hftStatus !== "object") {
    return null;
  }
  const quoteMonitorConnected = normalizeBool(hftStatus.quoteMonitorConnected);
  const osQuoteConnected = normalizeBool(hftStatus.osQuoteConnected);
  const loginConnected =
    stringOr(hftStatus.loginStatus).toLowerCase() === "connected" ||
    Number(hftStatus.loginCode) === 0;
  const subscribedCount =
    (Array.isArray(hftStatus.subscribedStocks) ? hftStatus.subscribedStocks.length : 0) +
    (Array.isArray(hftStatus.subscribedOsStocks) ? hftStatus.subscribedOsStocks.length : 0);
  return {
    status: loginConnected && (quoteMonitorConnected || osQuoteConnected) ? "connected" : "blocked",
    overallReady: loginConnected && (quoteMonitorConnected || osQuoteConnected),
    quoteEventConfirmed: Boolean(
      hftStatus.quoteStats?.lastQuoteAt || hftStatus.osQuoteStats?.lastQuoteAt,
    ),
    brokerActionRequired: false,
    currentBlockingCode: stringOr(hftStatus.blockerCode, ""),
    quoteUniverseCount: subscribedCount,
    lastHeartbeatAt: stringOr(hftStatus.generatedAt, ""),
    keepAliveUntil: "",
    capitalAccountSet: Number(hftStatus.accountsCount ?? 0) > 0,
    capitalAttempted: true,
    capitalMessage: stringOr(hftStatus.loginMessage, stringOr(hftStatus.loginMethod, "")),
    lastLogin1115Historical: false,
  };
}

function normalizeBridgeState(bridge, backgroundStatus, latestState, hftStatus) {
  const hftState = normalizeHftServiceState(hftStatus);
  const brokerActionRequired = normalizeBool(
    backgroundStatus?.brokerActionRequired ??
      bridge?.providers?.capital?.brokerActionRequired ??
      latestState?.brokerActionRequired ??
      hftState?.brokerActionRequired,
  );
  return {
    status:
      typeof backgroundStatus?.status === "string"
        ? backgroundStatus.status
        : typeof bridge?.status === "string"
          ? bridge.status
          : typeof hftState?.status === "string"
            ? hftState.status
            : "missing",
    overallReady:
      typeof backgroundStatus?.overallReady === "boolean"
        ? backgroundStatus.overallReady
        : typeof bridge?.overallReady === "boolean"
          ? bridge.overallReady
          : normalizeBool(hftState?.overallReady),
    quoteEventConfirmed: normalizeBool(
      backgroundStatus?.capital?.quoteEventConfirmed ??
        bridge?.quoteEventConfirmed ??
        latestState?.quoteEventConfirmed ??
        hftState?.quoteEventConfirmed,
    ),
    providers: {
      capital: {
        brokerActionRequired,
      },
    },
    brokerActionRequired,
    currentBlockingCode:
      typeof backgroundStatus?.currentBlockingCode === "string"
        ? backgroundStatus.currentBlockingCode
        : typeof bridge?.currentBlockingCode === "string"
          ? bridge.currentBlockingCode
          : typeof latestState?.currentBlockingCode === "string"
            ? latestState.currentBlockingCode
            : stringOr(hftState?.currentBlockingCode, ""),
    quoteUniverseCount: Number(
      backgroundStatus?.quoteUniverseCount ??
        bridge?.quoteUniverseCount ??
        latestState?.quoteUniverseCount ??
        hftState?.quoteUniverseCount ??
        0,
    ),
    lastHeartbeatAt:
      typeof backgroundStatus?.lastHeartbeatAt === "string"
        ? backgroundStatus.lastHeartbeatAt
        : typeof bridge?.lastHeartbeatAt === "string"
          ? bridge.lastHeartbeatAt
          : typeof latestState?.lastHeartbeatAt === "string"
            ? latestState.lastHeartbeatAt
            : stringOr(hftState?.lastHeartbeatAt, ""),
    keepAliveUntil:
      typeof backgroundStatus?.keepAliveUntil === "string"
        ? backgroundStatus.keepAliveUntil
        : typeof bridge?.keepAliveUntil === "string"
          ? bridge.keepAliveUntil
          : typeof latestState?.keepAliveUntil === "string"
            ? latestState.keepAliveUntil
            : stringOr(hftState?.keepAliveUntil, ""),
    capitalAccountSet: normalizeBool(
      backgroundStatus?.capital?.accountSet ??
        bridge?.capital?.accountSet ??
        latestState?.capitalAccountSet ??
        hftState?.capitalAccountSet,
    ),
    capitalAttempted: normalizeBool(
      backgroundStatus?.capital?.attempted ??
        bridge?.capital?.attempted ??
        latestState?.capitalAttempted ??
        hftState?.capitalAttempted,
    ),
    capitalMessage:
      typeof backgroundStatus?.capital?.message === "string"
        ? backgroundStatus.capital.message
        : typeof bridge?.capital?.message === "string"
          ? bridge.capital.message
          : typeof latestState?.capitalMessage === "string"
            ? latestState.capitalMessage
            : stringOr(hftState?.capitalMessage, ""),
    lastLogin1115Historical: normalizeBool(
      backgroundStatus?.lastLogin1115Historical ??
        bridge?.lastLogin1115Historical ??
        latestState?.lastLogin1115Historical ??
        hftState?.lastLogin1115Historical,
    ),
  };
}

function normalizeStockNo(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizeTargetStockNos(values) {
  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const candidate = normalizeStockNo(value);
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
}

function normalizeMarketCode(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function shouldPreferCanonicalCapitalHftStateDir(options) {
  const candidates = [];
  if (typeof options?.marketCode === "string") {
    candidates.push(options.marketCode);
  }
  if (typeof options?.targetStockNo === "string") {
    candidates.push(options.targetStockNo);
  }
  if (Array.isArray(options?.targetStockNos)) {
    candidates.push(...options.targetStockNos);
  }
  if (Array.isArray(options?.quoteAliases)) {
    candidates.push(...options.quoteAliases);
  }
  for (const value of candidates) {
    const candidate = normalizeStockNo(value);
    if (CANONICAL_ONLY_MARKET_HINTS.has(candidate)) {
      return true;
    }
  }
  return false;
}

async function readMarketRegistry(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw new Error(
      `Invalid market registry JSON: ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      {
        cause: error,
      },
    );
  }
}

function resolveQuoteTargetNos({
  targetStockNo,
  targetStockNos,
  quoteAliases,
  marketCode,
  marketRegistry,
  contractMonthSymbols,
}) {
  const candidates = [];
  if (Array.isArray(targetStockNos)) {
    candidates.push(...targetStockNos);
  }
  if (Array.isArray(quoteAliases)) {
    candidates.push(...quoteAliases);
  }
  if (Array.isArray(contractMonthSymbols)) {
    candidates.push(...contractMonthSymbols);
  }
  if (targetStockNo) {
    candidates.push(targetStockNo);
  }
  const normalizedMarketCode = normalizeMarketCode(marketCode);
  if (Array.isArray(QYAPI_QUOTE_ALIASES_BY_MARKET_CODE[normalizedMarketCode])) {
    candidates.push(...QYAPI_QUOTE_ALIASES_BY_MARKET_CODE[normalizedMarketCode]);
  }
  if (Array.isArray(QYAPI_OS_QUOTE_ALIASES_BY_INSTRUMENT[normalizedMarketCode])) {
    candidates.push(...QYAPI_OS_QUOTE_ALIASES_BY_INSTRUMENT[normalizedMarketCode]);
  }
  const marketProfile = normalizedMarketCode
    ? (marketRegistry?.markets?.[normalizedMarketCode] ??
      FALLBACK_MARKET_PROFILES[normalizedMarketCode] ??
      null)
    : null;
  if (marketProfile) {
    if (Array.isArray(marketProfile.quoteAliases)) {
      candidates.push(...marketProfile.quoteAliases);
    }
    candidates.push(marketProfile.runtimeSymbol);
    candidates.push(marketProfile.marketCode);
  }
  return {
    targetStockNos: normalizeTargetStockNos(candidates),
    marketCode: normalizedMarketCode,
    marketProfile,
  };
}

async function resolveContractMonthSymbols(marketCode) {
  const normalizedMarketCode = normalizeMarketCode(marketCode);
  if (!normalizedMarketCode) {
    return [];
  }
  try {
    const router = await buildCapitalContractMonthRouter({ marketCode: normalizedMarketCode });
    return router.routes
      .filter((route) => route.routeStatus === "resolved")
      .flatMap((route) => (Array.isArray(route.selectedSymbols) ? route.selectedSymbols : []));
  } catch {
    return [];
  }
}

function eventMatchesAnyTarget(event, targetStockNosSet) {
  return targetStockNosSet.has(normalizeStockNo(event?.stockNo));
}

function eventTimeMs(event) {
  const received = parseCapitalHftTimestamp(event?.receivedAt);
  return received ? received.getTime() : 0;
}

function osCacheEntryToQuoteEvent(entry) {
  if (!entry || typeof entry !== "object" || !entry.symbol) {
    return null;
  }
  return {
    schema: "openclaw.capital.quote-event.v1",
    provider: "capital-os",
    receivedAt: stringOr(entry.time, ""),
    eventSource: "SKOSQuoteLib.OnNotifyQuoteLONG",
    message: `收到群益海外報價事件: SKOSQuoteLib.OnNotifyQuoteLONG stockNo=${stringOr(entry.symbol)} name=${stringOr(entry.name)}`,
    stockNo: stringOr(entry.symbol),
    stockName: stringOr(entry.name),
    close: String(entry.price ?? ""),
    bid: String(entry.bid ?? ""),
    ask: String(entry.ask ?? ""),
    qty: String(entry.qty ?? ""),
  };
}

function osSymbolCacheEvents(osSymbolCache) {
  const symbols = osSymbolCache?.symbols;
  if (!symbols || typeof symbols !== "object") {
    return [];
  }
  return Object.values(symbols).map(osCacheEntryToQuoteEvent).filter(Boolean);
}

function extractNumericMessageField(event, fieldName) {
  const text = [event?.rawSummary, event?.message]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(" ");
  const match = text.match(new RegExp(`(?:^|\\s)${fieldName}=(-?\\d+(?:\\.\\d+)?)`, "u"));
  if (!match) {
    return null;
  }
  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

function almostEqual(left, right) {
  return Math.abs(left - right) <= Math.max(1, Math.abs(right) * 1e-9);
}

function normalizeQuotePrice(event, fieldName, decimal) {
  const value = event?.[fieldName];
  const numeric = Number(value);
  const digits = Number(decimal);
  if (!Number.isFinite(numeric) || !Number.isInteger(digits) || digits <= 0) {
    return String(value ?? "");
  }
  const scale = 10 ** digits;
  const rawFromMessage = extractNumericMessageField(event, fieldName);
  const displayNumeric =
    Number.isFinite(rawFromMessage) && almostEqual(numeric * scale, rawFromMessage)
      ? numeric
      : numeric / scale;
  return displayNumeric.toFixed(digits);
}

function normalizeSelectedQuote(selectedEvent) {
  const decimal = Number(selectedEvent?.decimal);
  const hasRawDecimal = Number.isInteger(decimal) && decimal > 0;
  if (!hasRawDecimal) {
    return {
      close: selectedEvent?.close ?? "",
      bid: selectedEvent?.bid ?? "",
      ask: selectedEvent?.ask ?? "",
      decimal: selectedEvent?.decimal ?? null,
      normalizedByDecimal: false,
    };
  }
  return {
    close: normalizeQuotePrice(selectedEvent, "close", decimal),
    bid: normalizeQuotePrice(selectedEvent, "bid", decimal),
    ask: normalizeQuotePrice(selectedEvent, "ask", decimal),
    rawClose: selectedEvent?.close ?? "",
    rawBid: selectedEvent?.bid ?? "",
    rawAsk: selectedEvent?.ask ?? "",
    decimal,
    normalizedByDecimal: true,
  };
}

function latestEventByTime(events) {
  return (
    events.filter(Boolean).toSorted((left, right) => eventTimeMs(right) - eventTimeMs(left))[0] ??
    null
  );
}

async function selectLatestQuoteEvent({
  latestEvent,
  latestOsEvent,
  osSymbolCache,
  eventStreamPath,
  targetStockNos,
}) {
  const normalizedTargetStockNos = normalizeTargetStockNos(targetStockNos ?? []);
  const normalizedTargetStockNosSet = new Set(normalizedTargetStockNos);
  const normalizedLatestStockNo = normalizeStockNo(latestEvent?.stockNo);
  const normalizedLatestOsStockNo = normalizeStockNo(latestOsEvent?.stockNo);
  const osCacheEvents = osSymbolCacheEvents(osSymbolCache);

  if (normalizedTargetStockNos.length === 0) {
    const selectedEvent = latestEventByTime([latestEvent, latestOsEvent]);
    return {
      selectedEvent,
      selectedFromEventStream: false,
      targetStockNo: "",
      targetStockNos: [],
      matched: selectedEvent != null,
      source: selectedEvent ? "latest_event" : "missing",
      reason: selectedEvent ? "latest quote event" : "latest quote event missing",
    };
  }

  if (normalizedTargetStockNosSet.has(normalizedLatestStockNo)) {
    return {
      selectedEvent: latestEvent ?? null,
      selectedFromEventStream: false,
      targetStockNo: normalizedLatestStockNo,
      targetStockNos: normalizedTargetStockNos,
      matched: latestEvent != null,
      source: latestEvent ? "latest_event" : "missing",
      reason: latestEvent
        ? "latest quote event matches target stock"
        : "latest quote event missing",
    };
  }

  if (normalizedTargetStockNosSet.has(normalizedLatestOsStockNo)) {
    return {
      selectedEvent: latestOsEvent ?? null,
      selectedFromEventStream: false,
      targetStockNo: normalizedLatestOsStockNo,
      targetStockNos: normalizedTargetStockNos,
      matched: latestOsEvent != null,
      source: latestOsEvent ? "latest_os_event" : "missing",
      reason: latestOsEvent
        ? "latest OS quote event matches target stock"
        : "latest OS quote event missing",
    };
  }

  const osCacheEvent = latestEventByTime(
    osCacheEvents.filter((event) => eventMatchesAnyTarget(event, normalizedTargetStockNosSet)),
  );
  if (osCacheEvent) {
    return {
      selectedEvent: osCacheEvent,
      selectedFromEventStream: false,
      targetStockNo: normalizeStockNo(osCacheEvent.stockNo),
      targetStockNos: normalizedTargetStockNos,
      matched: true,
      source: "os_symbol_cache",
      reason: "matched target stockNo from CapitalHftService OS symbol cache",
    };
  }

  try {
    const text = await fs.readFile(eventStreamPath, "utf8");
    const lines = text.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!OFFICIAL_CAPITAL_QUOTE_EVENTS.has(event?.eventSource)) {
        continue;
      }
      if (!eventMatchesAnyTarget(event, normalizedTargetStockNosSet)) {
        continue;
      }
      return {
        selectedEvent: event,
        selectedFromEventStream: true,
        targetStockNo: normalizeStockNo(event?.stockNo),
        targetStockNos: normalizedTargetStockNos,
        matched: true,
        source: "event_stream",
        reason: "matched target stockNo from quote event stream",
      };
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }

  return {
    selectedEvent: null,
    selectedFromEventStream: true,
    targetStockNo: normalizedTargetStockNos[0] ?? "",
    targetStockNos: normalizedTargetStockNos,
    matched: false,
    source: "event_stream",
    reason: "target stockNo not found in official quote event stream",
  };
}

function buildReaderState({
  stateDir,
  bridge,
  latestState,
  latestEvent,
  latestOsEvent,
  osSymbolCache,
  hftStatus,
  selectedEvent,
  selection,
  eventCount,
  latestEventHash,
  eventStreamHash,
  latestOsEventHash,
  osSymbolCacheHash,
}) {
  const source = hftStatus ? "CapitalHftService" : "CapitalHftService";
  const latestOverallEvent = latestEventByTime([latestEvent, latestOsEvent]);
  const osSymbolCount = Number(
    osSymbolCache?.symbolCount ??
      (osSymbolCache?.symbols && typeof osSymbolCache.symbols === "object"
        ? Object.keys(osSymbolCache.symbols).length
        : 0),
  );
  const bridgeReady = normalizeBool(bridge?.overallReady);
  const bridgeStatus = typeof bridge?.status === "string" ? bridge.status : "missing";
  const eventSource =
    typeof selectedEvent?.eventSource === "string" ? selectedEvent.eventSource : "";
  const quoteEventOfficial = OFFICIAL_CAPITAL_QUOTE_EVENTS.has(eventSource);
  const ageSeconds = quoteEventAgeSeconds(selectedEvent?.receivedAt);
  const freshnessThresholdSeconds = quoteFreshnessThresholdSeconds();
  const session = deriveTaipeiMarketSession();
  const quoteEventFreshness =
    ageSeconds === null ? "unknown" : ageSeconds <= freshnessThresholdSeconds ? "fresh" : "stale";
  const brokerActionRequired = normalizeBool(
    bridge?.providers?.capital?.brokerActionRequired ?? latestState?.brokerActionRequired,
  );
  const currentBlockingCode =
    typeof bridge?.currentBlockingCode === "string"
      ? bridge.currentBlockingCode
      : typeof latestState?.currentBlockingCode === "string"
        ? latestState.currentBlockingCode
        : "";
  const normalizedQuote = normalizeSelectedQuote(selectedEvent);
  const quoteEventReady = quoteEventOfficial && quoteEventFreshness === "fresh";
  const ready = quoteEventReady && bridgeReady && !brokerActionRequired && !currentBlockingCode;
  const status = ready ? "connected" : bridgeStatus === "missing" ? "missing" : "blocked";
  const reason = ready
    ? "群益報價事件已由 OpenClaw reader 收取；目前沒有 active blocking code。"
    : !quoteEventOfficial
      ? "尚未收取指定 stockNo 的官方 SKQuoteLib/SKOSQuoteLib 報價事件。"
      : !bridgeReady
        ? "報價事件存在，但 CapitalHftService bridge 尚未 connected 或 overallReady=false."
        : !quoteEventReady
          ? "報價事件存在，但 freshness 尚未達到即時門檻。"
          : brokerActionRequired || currentBlockingCode
            ? "報價事件存在，但 CapitalHftService bridge 仍標示 brokerActionRequired 或 currentBlockingCode。"
            : "CapitalHftService bridge 尚未 connected.";
  return {
    schema: "openclaw.capital.quote-reader.v1",
    generatedAt: new Date().toISOString(),
    provider: "capital",
    source,
    sourceStateDir: stateDir,
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    status,
    ready,
    reason,
    quoteProofStatus: quoteEventOfficial ? "confirmed" : "not_confirmed",
    quoteEventCount: eventCount + (Number.isFinite(osSymbolCount) ? osSymbolCount : 0),
    quoteEventAgeSeconds: ageSeconds,
    quoteEventFreshness,
    quoteEventFreshnessThresholdSeconds: freshnessThresholdSeconds,
    quote: {
      receivedAt: selectedEvent?.receivedAt ?? "",
      eventSource,
      stockNo: selectedEvent?.stockNo ?? "",
      stockName: selectedEvent?.stockName ?? "",
      close: normalizedQuote.close,
      bid: normalizedQuote.bid,
      ask: normalizedQuote.ask,
      rawClose: normalizedQuote.rawClose ?? "",
      rawBid: normalizedQuote.rawBid ?? "",
      rawAsk: normalizedQuote.rawAsk ?? "",
      decimal: normalizedQuote.decimal,
      normalizedByDecimal: normalizedQuote.normalizedByDecimal,
      qty: selectedEvent?.qty ?? "",
      message: selectedEvent?.message ?? "",
    },
    selection: {
      targetStockNo: selection?.targetStockNo ?? "",
      targetStockNos: Array.isArray(selection?.targetStockNos) ? selection.targetStockNos : [],
      marketCode: selection?.marketCode ?? "",
      source: selection?.source ?? "",
      matched: selection?.matched === true,
      selectedFromEventStream: selection?.selectedFromEventStream === true,
      latestOverallStockNo: latestOverallEvent?.stockNo ?? "",
      latestOverallReceivedAt: latestOverallEvent?.receivedAt ?? "",
    },
    session,
    health: {
      bridgeStatus,
      bridgeReady,
      brokerActionRequired,
      currentBlockingCode,
      quoteUniverseCount: Number(
        bridge?.quoteUniverseCount ?? latestState?.quoteUniverseCount ?? 0,
      ),
      overallReady: normalizeBool(bridge?.overallReady),
      quoteEventConfirmed: normalizeBool(bridge?.quoteEventConfirmed),
      lastHeartbeatAt: stringOr(bridge?.lastHeartbeatAt, ""),
      keepAliveUntil: stringOr(bridge?.keepAliveUntil, ""),
      capitalAccountSet: normalizeBool(bridge?.capitalAccountSet),
      capitalAttempted: normalizeBool(bridge?.capitalAttempted),
      capitalMessage: stringOr(bridge?.capitalMessage, ""),
      lastLogin1115Historical: normalizeBool(
        bridge?.lastLogin1115Historical ?? latestState?.lastLogin1115Historical,
      ),
    },
    files: {
      openClawQuoteBridge: path.join(stateDir, "openclaw_quote_bridge.json"),
      latestQuoteState: path.join(stateDir, "latest_quote_state.json"),
      latestQuoteEvent: path.join(stateDir, "capital_latest_quote_event.json"),
      quoteEvents: path.join(stateDir, "capital_quote_events.jsonl"),
      latestOsQuoteEvent: path.join(stateDir, "os_latest_quote_event.json"),
      osSymbolCache: path.join(stateDir, "os_symbol_cache.json"),
      hftServiceStatus: path.join(stateDir, "hft_service_status.json"),
      latestQuoteEventSha256: latestEventHash,
      quoteEventsSha256: eventStreamHash,
      latestOsQuoteEventSha256: latestOsEventHash,
      osSymbolCacheSha256: osSymbolCacheHash,
    },
  };
}

export async function readCapitalQuoteState(options = {}) {
  const explicitStateDir =
    typeof options.stateDir === "string" && options.stateDir.trim().length > 0
      ? options.stateDir
      : "";
  const stateDir = path.resolve(
    explicitStateDir || defaultCapitalHftStateDir(shouldPreferCanonicalCapitalHftStateDir(options)),
  );
  const marketRegistryPath = path.resolve(
    options.marketRegistryPath && String(options.marketRegistryPath).trim().length > 0
      ? options.marketRegistryPath
      : defaultMarketRegistryPath(),
  );
  const marketRegistry = await readMarketRegistry(marketRegistryPath);
  const requestedMarketCode = options.marketCode ?? process.env.OPENCLAW_CAPITAL_MARKET_CODE ?? "";
  const contractMonthSymbols = await resolveContractMonthSymbols(requestedMarketCode);
  const resolvedTargets = resolveQuoteTargetNos({
    targetStockNo: options.targetStockNo ?? process.env.OPENCLAW_CAPITAL_TARGET_STOCK_NO ?? "",
    targetStockNos: options.targetStockNos ?? [],
    quoteAliases: options.quoteAliases ?? [],
    marketCode: requestedMarketCode,
    marketRegistry,
    contractMonthSymbols,
  });
  const bridgePath = path.join(stateDir, "openclaw_quote_bridge.json");
  const backgroundStatusPath = path.join(stateDir, "background_quotes_status.json");
  const latestStatePath = path.join(stateDir, "latest_quote_state.json");
  const latestEventPath = path.join(stateDir, "capital_latest_quote_event.json");
  const eventStreamPath = path.join(stateDir, "capital_quote_events.jsonl");
  const latestOsEventPath = path.join(stateDir, "os_latest_quote_event.json");
  const osSymbolCachePath = path.join(stateDir, "os_symbol_cache.json");
  const hftStatusPath = path.join(stateDir, "hft_service_status.json");
  const [
    bridge,
    backgroundStatus,
    latestState,
    latestEvent,
    latestOsEvent,
    osSymbolCache,
    hftStatus,
    eventCount,
    latestEventHash,
    eventStreamHash,
    latestOsEventHash,
    osSymbolCacheHash,
  ] = await Promise.all([
    readJsonIfExists(bridgePath),
    readJsonIfExists(backgroundStatusPath),
    readJsonIfExists(latestStatePath),
    readJsonIfExists(latestEventPath),
    readJsonIfExists(latestOsEventPath),
    readJsonIfExists(osSymbolCachePath),
    readJsonIfExists(hftStatusPath),
    countJsonlLines(eventStreamPath),
    fileHashIfExists(latestEventPath),
    fileHashIfExists(eventStreamPath),
    fileHashIfExists(latestOsEventPath),
    fileHashIfExists(osSymbolCachePath),
  ]);
  const selection = await selectLatestQuoteEvent({
    latestEvent,
    latestOsEvent,
    osSymbolCache,
    eventStreamPath,
    targetStockNos: resolvedTargets.targetStockNos,
  });
  selection.marketCode = resolvedTargets.marketCode;
  selection.targetStockNos = resolvedTargets.targetStockNos;
  return buildReaderState({
    stateDir,
    bridge: normalizeBridgeState(bridge, backgroundStatus, latestState, hftStatus),
    latestState,
    latestEvent,
    latestOsEvent,
    osSymbolCache,
    hftStatus,
    selectedEvent: selection.selectedEvent,
    selection,
    eventCount,
    latestEventHash,
    eventStreamHash,
    latestOsEventHash,
    osSymbolCacheHash,
  });
}

export async function writeCapitalQuoteState(state, outputPath) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, text, "utf8");
  await fs.writeFile(`${outputPath}.sha256`, `${sha256Text(text)}\n`, "ascii");
  return outputPath;
}

function parseArgs(argv) {
  const options = {
    json: false,
    writeState: false,
    repoRoot: process.cwd(),
    stateDir: "",
    targetStockNo: "",
    targetStockNos: [],
    quoteAliases: [],
    marketCode: "",
    marketRegistryPath: defaultMarketRegistryPath(),
    output: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--repo-root") {
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
    } else if (arg === "--output") {
      options.output = argv[++index] ?? options.output;
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    }
  }
  return options;
}

function formatSummary(state, outputPath) {
  return [
    "OpenClaw Capital quote reader",
    `status=${state.status}`,
    `ready=${state.ready}`,
    `quoteProofStatus=${state.quoteProofStatus}`,
    `eventSource=${state.quote.eventSource || "N/A"}`,
    `stockNo=${state.quote.stockNo || "N/A"}`,
    `targetStockNo=${state.selection?.targetStockNo || ""}`,
    `marketCode=${state.selection?.marketCode || ""}`,
    `targetStockNos=${Array.isArray(state.selection?.targetStockNos) ? state.selection.targetStockNos.join(",") : ""}`,
    `session=${state.session?.marketSessionLabel || "N/A"}`,
    `brokerActionRequired=${state.health.brokerActionRequired}`,
    `currentBlockingCode=${state.health.currentBlockingCode || ""}`,
    outputPath ? `stateFile=${outputPath}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const state = await readCapitalQuoteState(options);
  const outputPath = options.writeState
    ? await writeCapitalQuoteState(
        state,
        path.resolve(options.output || repoStatePath(path.resolve(options.repoRoot))),
      )
    : "";
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...state, outputPath }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatSummary(state, outputPath)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital quote reader failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
