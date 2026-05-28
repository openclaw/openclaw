import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";

const DOMESTIC_EVENT_SOURCES = new Set([
  "SKQuoteLib.OnNotifyQuote",
  "SKQuoteLib.OnNotifyTicks",
  "SKQuoteLib.OnNotifyBest5",
  "SKQuoteLib.OnNotifyQuoteLONG",
  "SKQuoteLib.OnNotifyTicksLONG",
  "SKQuoteLib.OnNotifyBest5LONG",
]);

const OVERSEAS_EVENT_SOURCES = new Set([
  "SKOSQuoteLib.OnNotifyQuote",
  "SKOSQuoteLib.OnNotifyTicks",
  "SKOSQuoteLib.OnNotifyQuoteLONG",
  "SKOSQuoteLib.OnNotifyTicksLONG",
]);

const DEFAULT_MAX_FRESH_SECONDS = 300;
const DEFAULT_REQUIRED_NIGHT_MAX_FRESH_SECONDS = 21600;
const DEFAULT_BROKER_TIME_DRIFT_FALLBACK_SECONDS = 900;

const CORE_PRODUCTS = [
  {
    id: "tx-front",
    market: "domestic",
    label: "台指近",
    symbols: ["TX00", "TX06", "TX00AM", "TX00PM", "TXFR1", "TXF"],
    preferredSymbols: ["TX00", "TX06"],
    required: true,
    legacySessionAliases: ["TX00AM", "TX00PM"],
    note: "CapitalHftService CLAUDE.md defines TX00 as the active SKCOM fresh callback route; TX00AM/TX00PM are legacy/session aliases only.",
  },
  {
    id: "tx-06",
    market: "domestic",
    label: "台指06",
    symbols: ["TX06", "TX06AM", "TX06PM"],
    preferredSymbols: ["TX06"],
    required: false,
    legacySessionAliases: ["TX06AM", "TX06PM"],
    note: "CapitalHftService CLAUDE.md defines TX06 as the active SKCOM fresh callback route; TX06AM/TX06PM are legacy/session aliases only.",
  },
  {
    id: "te-front",
    market: "domestic",
    label: "電指近",
    symbols: ["TE00AM", "TE00PM", "TE00"],
    required: false,
  },
  {
    id: "xe-front",
    market: "domestic",
    label: "歐元近",
    symbols: ["XE0000AM", "XE0000PM", "XE0000"],
    required: false,
  },
  {
    id: "a50-hot",
    market: "overseas",
    label: "A50指熱",
    symbols: ["CN0000", "A50"],
    required: false,
    note: "A50 (CN0000) not always available in OS symbol cache due to SGX session gaps; demoted to optional to avoid blocking entire matrix. CapitalHftService OS callback resolves A50 hot contract as CN0000; obsolete OJO05/FA5005 routes must not be used as active quote targets.",
  },
  {
    id: "cad-hot",
    market: "overseas",
    label: "加幣熱",
    symbols: ["CD0000", "6C"],
    required: false,
  },
  {
    id: "crude-oil-hot",
    market: "overseas",
    label: "輕原油熱",
    symbols: ["CL0000", "QM0000", "MCL0000", "CL"],
    required: false,
    note: "Primary crude oil quick quote route uses CL0000; QM0000 and MCL0000 are tracked as same-family aliases.",
  },
  {
    id: "brent-oil-hot",
    market: "overseas",
    label: "布蘭特油熱",
    symbols: ["BZ0000", "BZ"],
    required: false,
    note: "Primary Brent oil quick quote route uses BZ0000.",
  },
  {
    id: "gold-hot",
    market: "overseas",
    label: "黃金熱",
    symbols: ["GC0000", "MGC0000", "1OZ0000", "GC"],
    required: false,
    note: "Primary gold quick quote route uses GC0000; MGC0000 and 1OZ0000 are tracked as same-family aliases.",
  },
  {
    id: "sp500-hot",
    market: "overseas",
    label: "標普熱",
    symbols: ["ES0000", "MES0000", "ES"],
    required: false,
    note: "Primary S&P 500 quick quote route uses ES0000; MES0000 is tracked as a micro alias.",
  },
  {
    id: "nasdaq-hot",
    market: "overseas",
    label: "那指熱",
    symbols: ["NQ0000", "MNQ0000", "NQ"],
    required: false,
    note: "Primary Nasdaq quick quote route uses NQ0000; MNQ0000 is tracked as a micro alias.",
  },
];

function defaultOutputPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-core-product-freshness-matrix.json");
}

function maxFreshSeconds() {
  const configured = Number(process.env.OPENCLAW_CAPITAL_CORE_MATRIX_FRESH_SECONDS ?? "");
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_FRESH_SECONDS;
}

function requiredNightMaxFreshSeconds(baseMaxFreshSeconds) {
  const configured = Number(process.env.OPENCLAW_CAPITAL_CORE_REQUIRED_NIGHT_FRESH_SECONDS ?? "");
  const fallback = Math.max(baseMaxFreshSeconds, DEFAULT_REQUIRED_NIGHT_MAX_FRESH_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : fallback;
}

function brokerTimeDriftFallbackSeconds() {
  const configured = Number(process.env.OPENCLAW_CAPITAL_BROKER_TIME_DRIFT_FALLBACK_SECONDS ?? "");
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_BROKER_TIME_DRIFT_FALLBACK_SECONDS;
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") {
      return null;
    }
    throw new Error(
      `Invalid JSON: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function readJsonlLatestBySymbol(filePath, allowedSources) {
  const latestBySymbol = new Map();
  try {
    const text = await fs.readFile(filePath, "utf8");
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const symbol = normalizeSymbol(event?.stockNo);
      if (!symbol || !allowedSources.has(event?.eventSource)) {
        continue;
      }
      latestBySymbol.set(symbol, event);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return latestBySymbol;
}

function normalizeSymbol(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizeSymbols(values) {
  return Array.isArray(values) ? values.map(normalizeSymbol).filter(Boolean) : [];
}

function parseTimestamp(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function deriveTaipeiFuturesSession(date = new Date()) {
  const taipeiNow = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const dayOfWeek = taipeiNow.getUTCDay();
  const totalMinutes = taipeiNow.getUTCHours() * 60 + taipeiNow.getUTCMinutes();
  if (dayOfWeek === 0 || (dayOfWeek === 6 && totalMinutes >= 5 * 60)) {
    return {
      marketSession: "session_closed",
      marketSessionLabel: "週末休市",
      tradingOpen: false,
      resumeCondition: "等下一個台指期交易時段開盤後回流 fresh callback。",
    };
  }
  if (dayOfWeek === 1 && totalMinutes < 8 * 60 + 45) {
    return {
      marketSession: "session_closed",
      marketSessionLabel: "週末後休市",
      tradingOpen: false,
      resumeCondition: "等週一 08:45 日盤開盤後回流 fresh callback。",
    };
  }
  if (totalMinutes >= 15 * 60 || totalMinutes < 5 * 60) {
    return {
      marketSession: "night",
      marketSessionLabel: "夜盤",
      tradingOpen: true,
      resumeCondition: "夜盤交易中，等待 fresh callback。",
    };
  }
  if (totalMinutes >= 13 * 60 + 45 && totalMinutes < 15 * 60) {
    return {
      marketSession: "inter_session",
      marketSessionLabel: "盤間",
      tradingOpen: false,
      resumeCondition: "等 15:00 夜盤開盤後回流 fresh callback。",
    };
  }
  if (totalMinutes >= 8 * 60 + 45 && totalMinutes < 13 * 60 + 45) {
    return {
      marketSession: "day",
      marketSessionLabel: "日盤",
      tradingOpen: true,
      resumeCondition: "日盤交易中，等待 fresh callback。",
    };
  }
  return {
    marketSession: "session_closed",
    marketSessionLabel: "休市",
    tradingOpen: false,
    resumeCondition: "等下一個台指期交易時段開盤後回流 fresh callback。",
  };
}

function extractNumericMessageField(event, fieldName) {
  const pattern = new RegExp(`\\b${fieldName}=([0-9]+)\\b`, "u");
  const text = `${event?.rawSummary ?? ""} ${event?.message ?? ""}`;
  const match = pattern.exec(text);
  return match ? Number(match[1]) : Number.NaN;
}

function parseCapitalMarketTimestamp(event) {
  const dateValue = Number(event?.date ?? extractNumericMessageField(event, "date"));
  const timeValue = Number(event?.time ?? extractNumericMessageField(event, "time"));
  if (!Number.isInteger(dateValue) || !Number.isInteger(timeValue)) {
    return null;
  }
  const dateText = String(dateValue).padStart(8, "0");
  const timeText = String(timeValue).padStart(6, "0");
  if (!/^\d{8}$/u.test(dateText) || !/^\d{6}$/u.test(timeText)) {
    return null;
  }
  const rawMilliseconds = Number(event?.ms ?? extractNumericMessageField(event, "ms"));
  const millisecond = Number.isFinite(rawMilliseconds)
    ? rawMilliseconds > 999
      ? Math.floor(rawMilliseconds / 1000)
      : rawMilliseconds
    : 0;
  return new Date(
    Number(dateText.slice(0, 4)),
    Number(dateText.slice(4, 6)) - 1,
    Number(dateText.slice(6, 8)),
    Number(timeText.slice(0, 2)),
    Number(timeText.slice(2, 4)),
    Number(timeText.slice(4, 6)),
    millisecond,
  );
}

function quoteFreshnessTimestamp(quote) {
  return typeof quote?.freshnessAt === "string" && quote.freshnessAt.trim().length > 0
    ? quote.freshnessAt
    : quote?.receivedAt;
}

function freshnessTimestampForAge(quote) {
  const base = parseTimestamp(quoteFreshnessTimestamp(quote));
  if (!base) {
    return null;
  }
  if (quote?.timeBasis !== "broker_event_time") {
    return base;
  }
  const broker = parseTimestamp(quote?.brokerMarketTime);
  const received = parseTimestamp(quote?.receivedAt);
  if (!broker || !received) {
    return base;
  }
  const driftSeconds = Math.abs(received.getTime() - broker.getTime()) / 1000;
  if (driftSeconds > brokerTimeDriftFallbackSeconds()) {
    return received;
  }
  return base;
}

function ageSecondsOf(quote, now) {
  const parsed = freshnessTimestampForAge(quote);
  return parsed ? Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 1000)) : null;
}

function decimalFromEvent(event) {
  const numeric = Number(event?.decimal);
  return Number.isFinite(numeric) ? numeric : 0;
}

function almostEqual(a, b) {
  return Math.abs(a - b) <= Math.max(1, Math.abs(b) * 1e-9);
}

function scaledNumber(event, fieldName, decimal) {
  const numeric = Number(event?.[fieldName]);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const rawFromSummary = extractNumericMessageField(event, fieldName);
  if (decimal > 0 && Number.isFinite(rawFromSummary)) {
    const scale = 10 ** decimal;
    if (almostEqual(numeric * scale, rawFromSummary)) {
      return numeric;
    }
    if (almostEqual(numeric, rawFromSummary)) {
      return numeric / scale;
    }
  }
  return decimal > 0 ? numeric / 10 ** decimal : numeric;
}

function cachePriceScale(symbol, value) {
  const normalized = normalizeSymbol(symbol);
  const instrument = normalizeSymbol(value?.instrument);
  if (normalized === "6C" || normalized.startsWith("CD") || instrument === "6C") {
    return 10000;
  }
  return 1;
}

function scaleCacheNumber(value, priceScale) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return priceScale > 1 ? Math.round((numeric / priceScale) * 1_000_000) / 1_000_000 : numeric;
}

function eventQuote(event) {
  const decimal = decimalFromEvent(event);
  const marketTime = parseCapitalMarketTimestamp(event);
  const receivedAt = event?.receivedAt ?? "";
  return {
    receivedAt,
    freshnessAt: marketTime ? marketTime.toISOString() : receivedAt,
    timeBasis: marketTime ? "broker_event_time" : "received_at",
    brokerMarketTime: marketTime ? marketTime.toISOString() : "",
    eventSource: event?.eventSource ?? "",
    stockNo: event?.stockNo ?? "",
    stockName: event?.stockName ?? "",
    decimal,
    bid: scaledNumber(event, "bid", decimal),
    ask: scaledNumber(event, "ask", decimal),
    close: scaledNumber(event, "close", decimal),
    qty: Number.isFinite(Number(event?.qty)) ? Number(event.qty) : null,
    raw: {
      bid: event?.bid ?? "",
      ask: event?.ask ?? "",
      close: event?.close ?? "",
      qty: event?.qty ?? "",
    },
  };
}

function cacheQuote(symbol, value) {
  const priceScale = cachePriceScale(symbol, value);
  return {
    receivedAt: value?.time ?? "",
    freshnessAt: value?.time ?? "",
    timeBasis: "os_symbol_cache_time",
    brokerMarketTime: "",
    eventSource: "os_symbol_cache",
    stockNo: symbol,
    stockName: value?.name ?? "",
    decimal: priceScale > 1 ? Math.log10(priceScale) : 0,
    bid: scaleCacheNumber(value?.bid, priceScale),
    ask: scaleCacheNumber(value?.ask, priceScale),
    close: scaleCacheNumber(value?.price, priceScale),
    qty: Number.isFinite(Number(value?.qty)) ? Number(value.qty) : null,
    priceScale,
    raw: {
      bid: value?.bid ?? "",
      ask: value?.ask ?? "",
      close: value?.price ?? "",
      qty: value?.qty ?? "",
    },
  };
}

function quoteBidAskUsable(quote) {
  return (
    Number.isFinite(quote?.bid) && quote.bid > 0 && Number.isFinite(quote?.ask) && quote.ask > 0
  );
}

function buildAliasDiagnostics(symbols, subscribedSymbols, seenSymbols, matchedSymbol) {
  return symbols.map((symbol) => ({
    symbol,
    subscribed: subscribedSymbols.has(symbol),
    seen: seenSymbols.has(symbol),
    matched: symbol === matchedSymbol,
  }));
}

function candidateAgeSeconds(candidate, now) {
  const ageSeconds = ageSecondsOf(candidate?.quote, now);
  return ageSeconds === null ? Number.POSITIVE_INFINITY : ageSeconds;
}

function fallbackCandidate(candidates, now, preferredSymbols = []) {
  const preferred = new Set(normalizeSymbols(preferredSymbols));
  return (
    candidates.toSorted((left, right) => {
      const leftPreferred = preferred.has(left.symbol);
      const rightPreferred = preferred.has(right.symbol);
      if (leftPreferred !== rightPreferred) {
        return leftPreferred ? -1 : 1;
      }
      return candidateAgeSeconds(left, now) - candidateAgeSeconds(right, now);
    })[0] ?? null
  );
}

function diagnoseQuoteBlock({
  status,
  quote,
  ageSeconds,
  bidAskUsable,
  subscribed,
  candidates,
  now,
  maxAgeSeconds,
  session,
}) {
  const hasCandidates = Array.isArray(candidates) && candidates.length > 0;
  const aliasStates = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const candidateAgeSeconds = ageSecondsOf(candidate.quote, now);
    const candidateBidAskUsable = quoteBidAskUsable(candidate.quote);
    return {
      symbol: candidate.symbol,
      ageSeconds: candidateAgeSeconds,
      bidAskUsable: candidateBidAskUsable,
      zeroOrUnusablePrice: !candidateBidAskUsable,
      eventSource: candidate.quote?.eventSource || "",
      receivedAt: candidate.quote?.receivedAt || "",
      brokerMarketTime: candidate.quote?.brokerMarketTime || "",
    };
  });
  let blockerCode = status;
  let probableCause = "unknown";
  let unblockCondition = "等待下一筆 fresh matched callback。";

  if (status === "session_closed") {
    blockerCode = session?.marketSession === "inter_session" ? "inter_session" : "session_closed";
    probableCause = `台指期目前為${session?.marketSessionLabel || "非交易時段"}，不應把 stale callback 判定為 API 錯誤。`;
    unblockCondition = session?.resumeCondition || "等待下一個交易時段回流 fresh callback。";
  } else if (!subscribed && !hasCandidates) {
    blockerCode = "not_subscribed";
    probableCause = "商品別名目前未在訂閱清單內。";
    unblockCondition = "把正確商品代號加入 CapitalHftService 訂閱清單。";
  } else if (subscribed && !hasCandidates) {
    blockerCode = "subscribed_no_callback";
    probableCause = "已訂閱但券商 callback 尚未回流此商品。";
    unblockCondition = "確認商品代號、交易時段、報價權限，等 callback 回流。";
  } else if (quote && ageSeconds === null) {
    blockerCode = "unknown_freshness";
    probableCause = "callback 有資料但時間無法解析。";
    unblockCondition = "修正 broker event time/receivedAt 解析。";
  } else if (quote && ageSeconds > maxAgeSeconds && !bidAskUsable) {
    blockerCode = "stale_zero_or_unusable_price";
    probableCause = "callback 已過期且買賣價為 0 或不可用。";
    unblockCondition =
      "等待 fresh callback 且 bid/ask 大於 0；若持續為 0，檢查交易時段、代號或報價權限。";
  } else if (quote && ageSeconds > maxAgeSeconds) {
    blockerCode = "stale_callback";
    probableCause =
      "callback 有回流但已超過 freshness 門檻，常見於休市、session 代號不符或該商品目前無跳動。";
    unblockCondition = `等待任一別名在 ${maxAgeSeconds}s 內回流 fresh callback。`;
  } else if (quote && !bidAskUsable) {
    blockerCode = "zero_or_unusable_price";
    probableCause = "callback 新鮮但 bid/ask 為 0 或不可用。";
    unblockCondition = "等待 bid/ask 大於 0；若持續為 0，檢查報價權限或商品代號。";
  } else if (status === "fresh") {
    blockerCode = "";
    probableCause = "fresh_matched_callback";
    unblockCondition = "";
  }

  return {
    blockerCode,
    probableCause,
    unblockCondition,
    aliasStates,
  };
}

function recommendedDiagnosticActions({ product, aliases, diagnostic }) {
  const actions = [];
  const legacySessionAliases = new Set(normalizeSymbols(product.legacySessionAliases ?? []));
  const sessionAliases = (Array.isArray(aliases) ? aliases : []).filter(
    (alias) => /(?:AM|PM)$/u.test(alias.symbol) && !legacySessionAliases.has(alias.symbol),
  );
  const missingSessionAliases = sessionAliases
    .filter((alias) => !alias.subscribed)
    .map((alias) => alias.symbol);
  if (missingSessionAliases.length > 0) {
    actions.push({
      code: "verify_session_alias_subscription",
      symbols: missingSessionAliases,
      summary: `檢查 ${product.label} 的 session mapping；若目前交易時段需要這些代號，加入訂閱清單。`,
    });
  }
  if (diagnostic?.blockerCode === "stale_callback") {
    actions.push({
      code: "refresh_or_wait_fresh_callback",
      summary: "已有 callback 但超過 freshness 門檻；先確認交易時段，再等待或重刷訂閱。",
    });
  }
  if (
    diagnostic?.blockerCode === "stale_zero_or_unusable_price" ||
    diagnostic?.blockerCode === "zero_or_unusable_price"
  ) {
    actions.push({
      code: "zero_price_root_cause",
      summary: "bid/ask 為 0 或不可用；依序查休市、報價權限、商品代號/session mapping。",
    });
  }
  if (actions.length === 0 && diagnostic?.blockerCode) {
    actions.push({
      code: "inspect_callback_state",
      summary: diagnostic.unblockCondition || "檢查訂閱、callback、交易時段與報價權限。",
    });
  }
  return actions;
}

function resolveProduct(product, sources, now, maxAgeSeconds, domesticSession) {
  const productMaxAgeSeconds =
    product.market === "domestic" &&
    product.required === true &&
    domesticSession?.marketSession === "night"
      ? requiredNightMaxFreshSeconds(maxAgeSeconds)
      : maxAgeSeconds;
  const symbols = normalizeSymbols(product.symbols);
  const source = product.market === "overseas" ? sources.overseas : sources.domestic;
  const subscribedSymbols =
    product.market === "overseas" ? sources.subscribedOverseas : sources.subscribedDomestic;
  const candidates = symbols
    .map((symbol) => ({ symbol, quote: source.get(symbol) }))
    .filter((candidate) => candidate.quote);
  const matched =
    candidates.find((candidate) => {
      const ageSeconds = ageSecondsOf(candidate.quote, now);
      return (
        ageSeconds !== null &&
        ageSeconds <= productMaxAgeSeconds &&
        quoteBidAskUsable(candidate.quote)
      );
    }) ?? fallbackCandidate(candidates, now, product.preferredSymbols);
  const matchedSymbol = matched?.symbol ?? "";
  const quote = matched?.quote ?? null;

  const ageSeconds = quote ? ageSecondsOf(quote, now) : null;
  const subscribed = symbols.some((symbol) => subscribedSymbols.has(symbol));
  const bidAskUsable = quoteBidAskUsable(quote);
  const aliases = buildAliasDiagnostics(symbols, subscribedSymbols, source, matchedSymbol);
  let status = "missing_callback";
  let reason = "No current callback/cache entry matched any configured symbol alias.";
  if (!subscribed && !quote) {
    status = "not_subscribed";
    reason = "No configured symbol alias is subscribed by CapitalHftService.";
  } else if (quote && ageSeconds === null) {
    status = "unknown_freshness";
    reason = "Matched quote exists but broker event time/receivedAt cannot be parsed.";
  } else if (quote && ageSeconds > productMaxAgeSeconds) {
    status = "stale";
    reason = `Matched quote is older than ${productMaxAgeSeconds}s.`;
  } else if (quote && !bidAskUsable) {
    status = "zero_or_unusable_price";
    reason = "Matched quote has missing or zero bid/ask.";
  } else if (quote) {
    status = "fresh";
    reason = "Matched quote is fresh and bid/ask usable.";
  }
  if (product.market === "domestic" && !domesticSession.tradingOpen && status !== "fresh") {
    status = "session_closed";
    reason = `Domestic futures are in ${domesticSession.marketSessionLabel}; stale or missing callback is expected until session resumes.`;
  }
  // 海外期貨休市判斷 (台北時間: 週六05:00 ~ 週一06:00 為休市)
  if (product.market === "overseas" && status !== "fresh") {
    const tpe = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
    const h = tpe.getHours();
    const d = tpe.getDay(); // 0=Sun
    const overseasClosed = (d === 6 && h >= 5) || d === 0 || (d === 1 && h < 6);
    if (overseasClosed) {
      status = "session_closed";
      reason =
        "Overseas futures market is closed (Sat 05:00 ~ Mon 06:00 TPE); stale quote is expected.";
    }
  }

  const diagnostic = diagnoseQuoteBlock({
    status,
    quote,
    ageSeconds,
    bidAskUsable,
    subscribed,
    candidates,
    now,
    maxAgeSeconds: productMaxAgeSeconds,
    session: product.market === "domestic" ? domesticSession : null,
  });
  diagnostic.recommendedActions = recommendedDiagnosticActions({ product, aliases, diagnostic });

  return {
    id: product.id,
    market: product.market,
    label: product.label,
    required: product.required === true,
    status,
    ready: status === "fresh",
    reason,
    matchedSymbol,
    subscribed,
    ageSeconds,
    maxFreshSeconds: productMaxAgeSeconds,
    session: product.market === "domestic" ? domesticSession : null,
    quote,
    aliases,
    diagnostic,
    note: product.note ?? "",
  };
}

function buildSources({ domesticEvents, overseasEvents, osSymbolCache, hftStatus }) {
  const domestic = new Map();
  const overseas = new Map();
  for (const [symbol, event] of domesticEvents.entries()) {
    domestic.set(symbol, eventQuote(event));
  }
  for (const [symbol, event] of overseasEvents.entries()) {
    overseas.set(symbol, eventQuote(event));
  }
  const osSymbols =
    osSymbolCache?.symbols && typeof osSymbolCache.symbols === "object"
      ? osSymbolCache.symbols
      : {};
  for (const [symbol, value] of Object.entries(osSymbols)) {
    overseas.set(normalizeSymbol(symbol), cacheQuote(normalizeSymbol(symbol), value));
  }
  return {
    domestic,
    overseas,
    subscribedDomestic: new Set(normalizeSymbols(hftStatus?.subscribedStocks)),
    subscribedOverseas: new Set(normalizeSymbols(hftStatus?.subscribedOsStocks)),
  };
}

export async function readCapitalCoreProductFreshnessMatrix(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const stateDir = path.resolve(options.stateDir || resolveCapitalHftStateDir());
  const now = options.now instanceof Date ? options.now : new Date();
  const maxAgeSeconds = Number.isFinite(Number(options.maxFreshSeconds))
    ? Number(options.maxFreshSeconds)
    : maxFreshSeconds();
  const domesticEventsPath = path.join(stateDir, "capital_quote_events.jsonl");
  const overseasEventsPath = path.join(stateDir, "os_quote_events.jsonl");
  const osSymbolCachePath = path.join(stateDir, "os_symbol_cache.json");
  const hftStatusPath = path.join(stateDir, "hft_service_status.json");
  const [domesticEvents, overseasEvents, osSymbolCache, hftStatus] = await Promise.all([
    readJsonlLatestBySymbol(domesticEventsPath, DOMESTIC_EVENT_SOURCES),
    readJsonlLatestBySymbol(overseasEventsPath, OVERSEAS_EVENT_SOURCES),
    readJsonIfExists(osSymbolCachePath),
    readJsonIfExists(hftStatusPath),
  ]);
  const sources = buildSources({ domesticEvents, overseasEvents, osSymbolCache, hftStatus });
  const domesticSession = deriveTaipeiFuturesSession(now);
  const products = CORE_PRODUCTS.map((product) =>
    resolveProduct(product, sources, now, maxAgeSeconds, domesticSession),
  );
  const requiredProducts = products.filter((product) => product.required);
  const requiredReady = requiredProducts.every((product) => product.ready);
  const freshCount = products.filter((product) => product.status === "fresh").length;
  const blockedProducts = products.filter((product) => product.required && !product.ready);
  const sessionClosedProducts = products.filter((product) => product.status === "session_closed");
  const requiredSessionClosed =
    blockedProducts.length > 0 &&
    blockedProducts.every((product) => product.status === "session_closed");

  return {
    schema: "openclaw.capital.core-product-freshness-matrix.v1",
    generatedAt: new Date().toISOString(),
    provider: "capital",
    source: "CapitalHftService callback/cache state",
    sourceStateDir: stateDir,
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    status: requiredReady ? "ready" : requiredSessionClosed ? "session_closed" : "blocked",
    ready: requiredReady,
    maxFreshSeconds: maxAgeSeconds,
    session: {
      domestic: domesticSession,
    },
    summary: {
      productCount: products.length,
      requiredCount: requiredProducts.length,
      freshCount,
      requiredReady,
      blockedRequiredIds: blockedProducts.map((product) => product.id),
      sessionClosedIds: sessionClosedProducts.map((product) => product.id),
      sessionClosedRequiredIds: sessionClosedProducts
        .filter((product) => product.required)
        .map((product) => product.id),
      domesticSeenCount: sources.domestic.size,
      overseasSeenCount: sources.overseas.size,
      subscribedDomesticCount: sources.subscribedDomestic.size,
      subscribedOverseasCount: sources.subscribedOverseas.size,
    },
    products,
    files: {
      domesticEvents: domesticEventsPath,
      overseasEvents: overseasEventsPath,
      osSymbolCache: osSymbolCachePath,
      hftServiceStatus: hftStatusPath,
      output: defaultOutputPath(repoRoot),
    },
    nextSafeTask: requiredReady
      ? "將 matrix 接入 Telegram /quote status 摘要，讓使用者直接看每個核心商品狀態。"
      : requiredSessionClosed
        ? "等待國內期貨交易時段恢復後重跑 matrix；期間禁止回舊價。"
        : "針對 blockedRequiredIds 逐一查商品代號、交易時段、訂閱與報價權限。",
  };
}

export async function writeCapitalCoreProductFreshnessMatrix(options = {}) {
  const matrix = await readCapitalCoreProductFreshnessMatrix(options);
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const outputPath = options.outputPath || defaultOutputPath(repoRoot);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const text = JSON.stringify(matrix, null, 2) + "\n";
  await fs.writeFile(outputPath, text);
  await fs.writeFile(`${outputPath}.sha256`, `${sha256Text(text)}\n`, "ascii");
  return { matrix, outputPath };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const result = await writeCapitalCoreProductFreshnessMatrix({ writeState: true });
  if (json) {
    console.log(JSON.stringify(result.matrix, null, 2));
  } else {
    const m = result.matrix;
    console.log("[" + m.status.toUpperCase() + "] Core Product Freshness Matrix");
    console.log(
      "  ready=" + m.ready + " fresh=" + m.summary.freshCount + "/" + m.summary.productCount,
    );
    if (m.summary.blockedRequiredIds.length) {
      console.log("  blocked: " + m.summary.blockedRequiredIds.join(", "));
    }
    for (const p of m.products) {
      console.log(
        "  [" +
          p.status +
          "] " +
          p.id +
          " (" +
          p.matchedSymbol +
          ") age=" +
          p.ageSeconds +
          "s" +
          (p.required ? " *required" : ""),
      );
    }
    console.log("  output: " + result.outputPath);
  }
}
