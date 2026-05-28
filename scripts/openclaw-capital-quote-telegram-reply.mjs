import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalContractMonthRouter } from "./openclaw-capital-contract-month-router.mjs";
import { readCapitalCoreProductFreshnessMatrix } from "./openclaw-capital-core-product-freshness-matrix.mjs";
import { refreshCapitalReportableQuoteState } from "./openclaw-capital-reportable-quote-refresh.mjs";
import { readCapitalServiceStatus } from "./openclaw-capital-service-status.mjs";
import { buildCapitalTelegramOwnerCheck } from "./openclaw-capital-telegram-owner-check.mjs";
import { buildCapitalTelegramSemiApprovalCallback } from "./openclaw-capital-telegram-semi-approval-callback.mjs";
import { buildCapitalTelegramSemiApprovalGate } from "./openclaw-capital-telegram-semi-approval-gate.mjs";

const DEFAULT_STATE_PATH = path.join(
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-quote-telegram-reply-latest.json",
);
const DEFAULT_AUTOMATION_STATE_PATH = path.join(
  "D:\\群益及元大API",
  "CapitalHftService",
  "state",
  "capital_automation_next_task_latest.json",
);
const DEFAULT_REPORTABLE_STATE_PATH = path.join(
  ".openclaw",
  "quote",
  "capital-reportable-quote-state.json",
);

const SUMMARY_TERMS = new Set(["", "ALL", "STATUS", "SUMMARY", "狀態", "全部", "總覽"]);
const CURRENT_MONTH_QUERY_RE = /(當月|本月|當期|CURRENT[-_\s]*MONTH|CURRENTMONTH)/iu;
const NEXT_MONTH_QUERY_RE = /(下個月|下月|次月|NEXT[-_\s]*MONTH|NEXTMONTH)/iu;
const TELEGRAM_OWNER_TERMS = new Set([
  "TELEGRAM",
  "TG",
  "OWNER",
  "POLLER",
  "收訊",
  "入口",
  "自檢",
  "單一入口",
]);
const NATURAL_PRODUCT_QUERIES = [
  { symbol: "CL0000", pattern: /(原油期貨|輕原油|美油|原油|WTI|CRUDE|CL0000|CL熱|^CL$)/iu },
  { symbol: "BZ0000", pattern: /(布蘭特油|布蘭特|BRENT|BZ0000|BZ熱|^BZ$)/iu },
  { symbol: "GC0000", pattern: /(黃金期貨|黃金|GOLD|GC0000|MGC0000|1OZ0000|GC熱|^GC$)/iu },
  { symbol: "ES0000", pattern: /(標普期貨|標普|S&P|SP500|ES0000|MES0000|ES熱|^ES$)/iu },
  {
    symbol: "NQ0000",
    pattern: /(那指期貨|那斯達克|納斯達克|小那|NASDAQ|NQ0000|MNQ0000|NQ熱|^NQ$)/iu,
  },
];
const KNOWN_OVERSEAS_PRODUCT_FALLBACKS = [
  {
    id: "gold-hot",
    label: "黃金熱",
    matchedSymbol: "GC0000",
    aliases: ["GC0000", "MGC0000", "1OZ0000", "GC", "黃金", "黃金期貨"],
    blockerCode: "missing_callback",
    status: "missing_callback",
    reason: "群益海外商品代號已知，但目前沒有 fresh callback 回流。",
    action: "確認 GC0000/MGC0000/1OZ0000 訂閱與報價權限，等 fresh callback 後才回價。",
  },
  {
    id: "sp500-hot",
    label: "標普熱",
    matchedSymbol: "ES0000",
    aliases: ["ES0000", "MES0000", "ES", "標普", "標普期貨", "SP500", "S&P"],
    blockerCode: "missing_callback",
    status: "missing_callback",
    reason: "群益海外商品代號已知，但目前沒有 fresh callback 回流。",
    action: "確認 ES0000/MES0000 訂閱與報價權限，等 fresh callback 後才回價。",
  },
  {
    id: "nasdaq-hot",
    label: "那指熱",
    matchedSymbol: "NQ0000",
    aliases: ["NQ0000", "MNQ0000", "NQ", "那指", "小那", "那指期貨", "NASDAQ"],
    blockerCode: "missing_callback",
    status: "missing_callback",
    reason: "群益海外商品代號已知，但目前沒有 fresh callback 回流。",
    action: "確認 NQ0000/MNQ0000 訂閱與報價權限，等 fresh callback 後才回價。",
  },
];

function normalizeSearchText(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/(報價|即時價|最新價|目前價|現在價|價位|點位|價格|目前|現在|最新)/gu, "")
    .replace(/\s+/gu, "");
}

function stripQuoteCommand(value) {
  return String(value ?? "")
    .trim()
    .replace(/^\/QUOTE(?:@[A-Z0-9_]+)?/iu, "")
    .trim();
}

function normalizeNaturalProductQuery(queryText) {
  const raw = String(queryText ?? "").trim();
  if (!raw || SUMMARY_TERMS.has(normalizeSearchText(raw))) {
    return raw;
  }
  const direct = NATURAL_PRODUCT_QUERIES.find((entry) => entry.pattern.test(raw));
  return direct?.symbol || raw;
}

function formatNumber(value) {
  return Number.isFinite(value) ? String(value) : "--";
}

function formatAge(ageSeconds) {
  return Number.isFinite(ageSeconds) ? `${ageSeconds}秒` : "未知";
}

function statusLabel(status) {
  switch (status) {
    case "fresh":
      return "即時";
    case "stale":
      return "已過期";
    case "zero_or_unusable_price":
      return "0價或不可用";
    case "not_subscribed":
      return "未訂閱";
    case "missing_callback":
      return "未回流";
    case "session_closed":
      return "SESSION_CLOSED";
    case "unknown_freshness":
      return "時間未知";
    case "not_ready":
      return "未就緒";
    case "requires_catalog_verification":
      return "需官方商品明細驗證";
    case "blocked_contract_month":
      return "月份規則封鎖";
    default:
      return String(status || "未知");
  }
}

function reasonLabel(product) {
  switch (product?.status) {
    case "stale":
      return `報價超過 ${product?.maxFreshSeconds ?? "--"} 秒未更新`;
    case "zero_or_unusable_price":
      return "買賣價缺失或為 0";
    case "not_subscribed":
      return "目前未訂閱此商品代號";
    case "missing_callback":
      return "目前沒有符合商品代號的 callback 回流";
    case "session_closed": {
      const session = product?.session ?? {};
      const label =
        session.marketSession === "inter_session"
          ? "盤間無 fresh tick"
          : `${session.marketSessionLabel || "非交易時段"}無 fresh tick`;
      return `${label}；${session.resumeCondition || "等待交易時段恢復後才回報 fresh tick"}`;
    }
    case "unknown_freshness":
      return "回流時間無法解析";
    default:
      return product?.reason || "報價尚未達到 fresh matched 條件";
  }
}

function deriveTaipeiFuturesSession(date = new Date()) {
  const taipeiNow = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const totalMinutes = taipeiNow.getUTCHours() * 60 + taipeiNow.getUTCMinutes();
  if (totalMinutes >= 13 * 60 + 45 && totalMinutes < 15 * 60) {
    return {
      marketSession: "inter_session",
      marketSessionLabel: "盤間",
      tradingOpen: false,
      resumeCondition: "等 15:00 夜盤開盤後回流 fresh callback。",
    };
  }
  return {
    marketSession: "session_closed",
    marketSessionLabel: "非交易時段",
    tradingOpen: false,
    resumeCondition: "等待交易時段恢復後回流 fresh callback。",
  };
}

function applyServiceSessionClosed(product, serviceStatus) {
  if (serviceStatus?.quote?.status !== "session_closed" || product?.market !== "domestic") {
    return product;
  }
  const session = deriveTaipeiFuturesSession();
  return {
    ...product,
    status: "session_closed",
    ready: false,
    session,
    reason: serviceStatus.quote.reason || product?.reason || "Domestic futures session closed.",
    diagnostic: {
      ...product?.diagnostic,
      blockerCode: session.marketSession === "inter_session" ? "inter_session" : "session_closed",
      probableCause: `台指期目前為${session.marketSessionLabel}，不應把 stale callback 判定為 API 錯誤。`,
      unblockCondition: session.resumeCondition,
    },
  };
}

function formatMatrixProductSummary(product) {
  const quote = product?.quote ?? {};
  const label = product?.label || quote.stockName || product?.id || "--";
  const symbol = product?.matchedSymbol || quote.stockNo || "--";
  if (product?.ready === true && product?.status === "fresh") {
    return [
      `${label}/${symbol}=即時`,
      `買${formatNumber(quote.bid)}`,
      `賣${formatNumber(quote.ask)}`,
      `成${formatNumber(quote.close)}`,
      `延遲${formatAge(product.ageSeconds)}`,
    ].join(" ");
  }
  return [
    `${label}/${symbol}=封鎖:${statusLabel(product?.status || "not_ready")}`,
    `原因=${reasonLabel(product)}`,
    `診斷=${product?.diagnostic?.blockerCode || product?.diagnostic?.probableCause || "未分類"}`,
    `修復=${product?.diagnostic?.recommendedActions?.[0]?.summary || product?.diagnostic?.unblockCondition || "待分析"}`,
    `延遲${formatAge(product?.ageSeconds)}`,
  ].join(" ");
}

function productTokens(product) {
  const aliasSymbols = Array.isArray(product?.aliases)
    ? product.aliases.map((alias) => alias?.symbol).filter(Boolean)
    : [];
  return [
    product?.id,
    product?.label,
    product?.matchedSymbol,
    product?.quote?.stockNo,
    product?.quote?.stockName,
    ...aliasSymbols,
  ]
    .filter(Boolean)
    .map((token) => String(token));
}

function findProductByQuery(matrix, queryText) {
  const normalizedQuery = normalizeSearchText(queryText);
  if (SUMMARY_TERMS.has(normalizedQuery)) {
    return null;
  }
  return (Array.isArray(matrix?.products) ? matrix.products : []).find((product) =>
    productTokens(product).some((token) => {
      const normalizedToken = normalizeSearchText(token);
      return normalizedToken === normalizedQuery || normalizedToken.includes(normalizedQuery);
    }),
  );
}

function resolveContractMonthQuery(queryText) {
  const raw = String(queryText ?? "").trim();
  const routingMode = NEXT_MONTH_QUERY_RE.test(raw)
    ? "next-month"
    : CURRENT_MONTH_QUERY_RE.test(raw)
      ? "current-month"
      : "";
  if (!routingMode) {
    return null;
  }
  const normalized = normalizeSearchText(raw);
  if (/TXF|台指期|台指/u.test(raw) || normalized.includes("TX")) {
    return { marketCode: "TXF", routingMode };
  }
  if (/A50|CN0000|富時中國|新加坡A50/iu.test(raw)) {
    return { marketCode: "A50", routingMode };
  }
  if (/(輕原油|原油|WTI|CRUDE|^CL|CL$)/iu.test(raw)) {
    return { marketCode: "CL", routingMode };
  }
  if (/(那指|那斯達克|納斯達克|NASDAQ|^NQ|NQ$)/iu.test(raw)) {
    return { marketCode: "NQ", routingMode };
  }
  if (/(標普|S&P|SP500|^ES|ES$)/iu.test(raw)) {
    return { marketCode: "ES", routingMode };
  }
  if (/(道瓊|小道|DOW|^YM|YM$)/iu.test(raw)) {
    return { marketCode: "YM", routingMode };
  }
  return null;
}

function findContractRoute(contractRouter, request) {
  const routes = Array.isArray(contractRouter?.routes) ? contractRouter.routes : [];
  return (
    routes.find(
      (route) =>
        route?.marketCode === request.marketCode && route?.routingMode === request.routingMode,
    ) || null
  );
}

function findProductByRouteSymbols(matrix, route) {
  const symbols = new Set(
    (Array.isArray(route?.selectedSymbols) ? route.selectedSymbols : [])
      .map((symbol) => normalizeSearchText(symbol))
      .filter(Boolean),
  );
  if (symbols.size === 0) {
    return null;
  }
  return (
    (Array.isArray(matrix?.products) ? matrix.products : []).find((product) =>
      productTokens(product).some((token) => symbols.has(normalizeSearchText(token))),
    ) || null
  );
}

function productFromContractRoute(route) {
  const selectedSymbols = Array.isArray(route?.selectedSymbols) ? route.selectedSymbols : [];
  const primarySymbol = selectedSymbols[0] || route?.marketCode || "--";
  const routeStatus = String(route?.routeStatus || "");
  const routeReadiness = String(route?.quoteReadiness || "");
  const blockedStatus =
    routeStatus === "requires_catalog_verification"
      ? "requires_catalog_verification"
      : routeStatus === "blocked"
        ? "blocked_contract_month"
        : routeReadiness === "needs_subscription_callback"
          ? "missing_callback"
          : routeReadiness === "blocked"
            ? "stale"
            : "not_ready";
  return {
    id: `${String(route?.marketCode || "contract").toLowerCase()}-${route?.routingMode || "route"}`,
    market: route?.venue || "",
    label: `${route?.productName || route?.marketCode || "期貨"}${
      route?.routingMode === "current-month"
        ? "當月"
        : route?.routingMode === "next-month"
          ? "下月"
          : ""
    }`,
    required: false,
    status: blockedStatus,
    ready: false,
    matchedSymbol: primarySymbol,
    ageSeconds: Number.NaN,
    maxFreshSeconds: 60,
    reason: route?.reason || "月份路由已解析，但目前沒有 fresh matched callback 可回報。",
    quote: {
      stockNo: primarySymbol,
      stockName: route?.productName || route?.marketCode || "",
      eventSource: "contract-month-router",
      bid: null,
      ask: null,
      close: null,
    },
    aliases: selectedSymbols.map((symbol, index) => ({
      symbol,
      matched: index === 0,
    })),
    contractRoute: route,
    diagnostic: {
      blockerCode: route?.blockerCode || routeReadiness || "contract_month_not_fresh_matched",
      probableCause: route?.reason || "目前沒有符合當月合約的 fresh callback。",
      unblockCondition:
        "訂閱月份路由列出的商品代號，等群益官方 fresh callback 回流後才可回報或供策略使用。",
      recommendedActions: [
        {
          summary: `確認訂閱 ${selectedSymbols.join(",") || primarySymbol}，不可用熱月代號替代當月查詢。`,
        },
      ],
    },
  };
}

function applyContractRouteToProduct(product, route) {
  return {
    ...product,
    contractRoute: route,
  };
}

function knownFallbackProductByQuery(queryText) {
  const normalizedQuery = normalizeSearchText(queryText);
  if (!normalizedQuery || SUMMARY_TERMS.has(normalizedQuery)) {
    return null;
  }
  const fallback = KNOWN_OVERSEAS_PRODUCT_FALLBACKS.find((entry) =>
    [entry.id, entry.label, entry.matchedSymbol, ...entry.aliases].some((token) => {
      const normalizedToken = normalizeSearchText(token);
      return normalizedToken === normalizedQuery || normalizedToken.includes(normalizedQuery);
    }),
  );
  if (!fallback) {
    return null;
  }
  return {
    id: fallback.id,
    market: "overseas",
    label: fallback.label,
    required: false,
    status: fallback.status,
    ready: false,
    matchedSymbol: fallback.matchedSymbol,
    ageSeconds: Number.NaN,
    maxFreshSeconds: 300,
    reason: fallback.reason,
    quote: {
      stockNo: fallback.matchedSymbol,
      stockName: fallback.label,
      eventSource: "",
      bid: null,
      ask: null,
      close: null,
    },
    aliases: fallback.aliases.map((symbol) => ({
      symbol,
      matched: symbol === fallback.matchedSymbol,
    })),
    diagnostic: {
      blockerCode: fallback.blockerCode,
      probableCause: fallback.reason,
      unblockCondition: "必須等群益官方 SKOSQuoteLib fresh callback 回流。",
      recommendedActions: [{ summary: fallback.action }],
    },
  };
}

function isReportableQuoteState(value) {
  return value?.schema === "openclaw.capital.reportable-quote-state.v1";
}

function ageSecondsFromQuote(quote) {
  const parsed = Date.parse(quote?.brokerMarketTime ?? quote?.receivedAt ?? "");
  if (!Number.isFinite(parsed)) {
    return Number.NaN;
  }
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

function maxFreshSecondsFromQuote(quote) {
  const maxAgeMs = Number(quote?.maxAgeMs);
  return Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? Math.ceil(maxAgeMs / 1000) : 60;
}

function quoteProductId(quote) {
  return (
    normalizeSearchText(quote?.query || quote?.symbol || quote?.name || "quote")
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/giu, "-")
      .replace(/^-+|-+$/gu, "") || "quote"
  );
}

function reportableQuoteToProduct(quote) {
  const symbol = String(quote?.symbol ?? quote?.query ?? "").toUpperCase();
  const query = String(quote?.query ?? symbol).toUpperCase();
  const ageSeconds = ageSecondsFromQuote(quote);
  const maxFreshSeconds = maxFreshSecondsFromQuote(quote);
  const freshNow = Number.isFinite(ageSeconds) && ageSeconds <= maxFreshSeconds;
  return {
    id: quoteProductId(quote),
    market: quote?.source ?? "",
    label: quote?.name || symbol,
    required: false,
    status: freshNow ? "fresh" : "stale",
    ready: freshNow,
    matchedSymbol: symbol,
    ageSeconds,
    maxFreshSeconds,
    reason: "Reportable quote state marked this quote fresh and matched.",
    quote: {
      stockNo: symbol,
      stockName: quote?.name ?? "",
      eventSource: quote?.sourceFile ?? quote?.timeBasis ?? "reportable_quote_state",
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      close: quote?.close ?? null,
    },
    aliases: [
      { symbol, matched: true },
      query !== symbol ? { symbol: query, matched: false } : null,
    ].filter(Boolean),
  };
}

function blockedQuoteStatus(quote) {
  const category = String(quote?.blockedCategory ?? quote?.diagnosis ?? "").toLowerCase();
  switch (category) {
    case "zero_price_callback":
    case "zero_or_unusable_price":
      return "zero_or_unusable_price";
    case "not_subscribed":
      return "not_subscribed";
    case "missing_callback":
      return "missing_callback";
    case "session_closed":
      return "session_closed";
    case "stale":
    case "stale_callback":
      return "stale";
    default:
      return "stale";
  }
}

function blockedQuoteToProduct(quote) {
  const event = quote?.lastEvent ?? {};
  const symbol = String(quote?.symbol ?? event.stockNo ?? "").toUpperCase();
  const matchedSymbol = String(event.stockNo ?? symbol).toUpperCase();
  const status = blockedQuoteStatus(quote);
  return {
    id: quoteProductId({ ...quote, query: symbol, name: event.stockName }),
    market: quote?.source ?? "",
    label: event.stockName || symbol,
    required: false,
    status,
    ready: false,
    matchedSymbol,
    ageSeconds: ageSecondsFromQuote(event),
    reason: quote?.reason ?? quote?.blockedCategory ?? "blocked",
    quote: {
      stockNo: matchedSymbol,
      stockName: event.stockName ?? "",
      eventSource: event.sourceFile ?? event.timeBasis ?? "reportable_quote_state",
      bid: event.bid ?? null,
      ask: event.ask ?? null,
      close: event.close ?? null,
    },
    aliases: [
      { symbol, matched: matchedSymbol === symbol },
      matchedSymbol !== symbol ? { symbol: matchedSymbol, matched: true } : null,
    ].filter(Boolean),
    diagnostic: {
      blockerCode: quote?.blockedCategory ?? quote?.diagnosis ?? "blocked",
      probableCause: quote?.reason ?? "",
      unblockCondition: quote?.unblockCondition ?? "",
      recommendedActions: quote?.recommendedAction ? [{ summary: quote.recommendedAction }] : [],
    },
  };
}

function reportableStateToMatrix(state) {
  const reportableQuotes = Array.isArray(state?.reportableQuotes) ? state.reportableQuotes : [];
  const blockedQuotes = Array.isArray(state?.blockedQuotes) ? state.blockedQuotes : [];
  const products = [
    ...reportableQuotes.map(reportableQuoteToProduct),
    ...blockedQuotes.map(blockedQuoteToProduct),
  ];
  const freshCount = products.filter(
    (product) => product.ready === true && product.status === "fresh",
  ).length;
  return {
    schema: "openclaw.capital.core-product-freshness-matrix.v1",
    status: state?.status === "ready" ? "ready" : "partial_ready",
    ready: blockedQuotes.length === 0,
    summary: {
      productCount: products.length,
      requiredCount: 0,
      freshCount,
      requiredReady: true,
      blockedRequiredIds: [],
    },
    products,
    sourceReportableState: state,
  };
}

function quoteMatrix(input) {
  return isReportableQuoteState(input) ? reportableStateToMatrix(input) : input;
}

function isTelegramOwnerQuery(queryText) {
  const normalizedQuery = normalizeSearchText(queryText);
  return TELEGRAM_OWNER_TERMS.has(normalizedQuery);
}

function aliasNote(product, queryText) {
  const normalizedQuery = normalizeSearchText(queryText);
  const matched = normalizeSearchText(product?.matchedSymbol);
  if (!normalizedQuery || normalizedQuery === matched) {
    return "";
  }
  const aliases = Array.isArray(product?.aliases) ? product.aliases : [];
  const alias = aliases.find((entry) => normalizeSearchText(entry?.symbol) === normalizedQuery);
  if (!alias || alias.matched) {
    return "";
  }
  return `；查詢代號 ${alias.symbol} 已對應到實際回流 ${product.matchedSymbol || "--"}`;
}

function summarizeAutomation(automationState) {
  if (!automationState || typeof automationState !== "object") {
    return "";
  }
  const freshness = automationState.freshnessMatrix?.summary ?? {};
  const failedSteps = Array.isArray(automationState.failedSteps) ? automationState.failedSteps : [];
  return [
    `自動化=${automationState.status ?? "unknown"}`,
    `freshness=${freshness.freshCount ?? 0}/${freshness.productCount ?? 0}`,
    `failedSteps=${failedSteps.length ? failedSteps.join(",") : "無"}`,
    `sentOrder=${automationState.safety?.sentOrder === true ? "true" : "false"}`,
  ].join("｜");
}

function summarizeAutomationConsistency(matrix, automationState) {
  if (!automationState || typeof automationState !== "object") {
    return "";
  }
  const liveSummary = matrix?.summary ?? {};
  const automationSummary = automationState.freshnessMatrix?.summary ?? {};
  const liveFresh = Number(liveSummary.freshCount ?? 0);
  const liveTotal = Number(liveSummary.productCount ?? 0);
  const automationFresh = Number(automationSummary.freshCount ?? 0);
  const automationTotal = Number(automationSummary.productCount ?? 0);
  if (
    !Number.isFinite(liveFresh) ||
    !Number.isFinite(liveTotal) ||
    !Number.isFinite(automationFresh) ||
    !Number.isFinite(automationTotal)
  ) {
    return "";
  }
  if (
    liveFresh === automationFresh &&
    liveTotal === automationTotal &&
    liveSummary.requiredReady === automationSummary.requiredReady
  ) {
    return "";
  }
  return `一致性：即時矩陣=${liveFresh}/${liveTotal}｜自動化快照=${automationFresh}/${automationTotal}｜以即時矩陣為準`;
}

function summarizeServiceStatus(serviceStatus) {
  if (!serviceStatus?.replyLine) {
    return "";
  }
  const parts = String(serviceStatus.replyLine)
    .replace(/^\[OpenClaw Capital 狀態\]\s*/u, "")
    .split("｜")
    .filter(Boolean);
  const quotePart = parts.find((part) => part.startsWith("報價=")) || "報價=unknown";
  const otherParts = parts.filter((part) => !part.startsWith("報價="));
  return [`服務狀態：${quotePart}`, ...otherParts, "商品逐筆=以商品明細為準"].join("｜");
}

function resolveServiceStatusBlocker(serviceStatus) {
  const poller = serviceStatus?.telegramPoller;
  if (!poller || typeof poller !== "object") {
    return null;
  }
  if (poller.pollingEnabled === true) {
    return {
      code: "capital_telegram_polling_enabled",
      reason: `CapitalHftService 正在 polling Telegram；必須由 OpenClaw Gateway 統一接收 getUpdates`,
      current: poller.summary || poller.pollingOwner || "capital_hft_service",
    };
  }
  if (poller.duplicatePollerDetected === true) {
    return {
      code: "duplicate_poller_detected",
      reason: "Telegram Bot API 回報同一 token 有重複 getUpdates poller",
      current: poller.summary || "duplicate_poller_detected",
    };
  }
  if (poller.pollState === "poll_error") {
    return {
      code: "telegram_poll_error",
      reason: poller.lastPollErrorMessage || poller.lastPollErrorStatus || "Telegram polling error",
      current: poller.summary || "poll_error",
    };
  }
  return null;
}

function serviceBlockedReply(queryText, blocker) {
  return [
    `[OpenClaw 報價] 封鎖:${blocker.code}`,
    `查詢=${queryText || "status"}`,
    `原因=${blocker.reason}`,
    `目前=${blocker.current}`,
    "修正=OpenClaw Gateway 接收 Telegram；CapitalHftService 保持 send-only",
    "不可回舊價",
    "不可用於策略或下單",
    "真單=封鎖（風控未開啟）",
  ].join("｜");
}

function summarizeMatrix(matrix, serviceStatus = null, automationState = null) {
  const summary = matrix?.summary ?? {};
  const products = Array.isArray(matrix?.products) ? matrix.products : [];
  const watch = products
    .filter((product) => product?.ready !== true)
    .map((product) => `${product.id}:${statusLabel(product.status)}`)
    .join(",");
  const requiredReady = products.filter((product) => product?.required && product?.ready).length;
  const requiredCount = products.filter((product) => product?.required).length;
  const lines = [
    `[OpenClaw 報價] 核心商品：已就緒 ${summary.freshCount ?? 0}/${summary.productCount ?? products.length}`,
    `必要商品：${requiredReady}/${requiredCount}`,
    `需處理：${watch || "無"}`,
  ];
  if (products.length > 0) {
    lines.push(`商品明細：${products.map(formatMatrixProductSummary).join("；")}`);
  }
  const serviceSummary = summarizeServiceStatus(serviceStatus);
  if (serviceSummary) {
    lines.push(serviceSummary);
  }
  const automationSummary = summarizeAutomation(automationState);
  if (automationSummary) {
    lines.push(`自動化狀態：${automationSummary}`);
  }
  const consistencySummary = summarizeAutomationConsistency(matrix, automationState);
  if (consistencySummary) {
    lines.push(consistencySummary);
  }
  lines.push("真單：封鎖（風控未開啟）");
  return lines.join("｜");
}

function resolveSummaryBlockerCode(serviceStatus) {
  const blocker = String(serviceStatus?.blockerCode ?? "").trim();
  return blocker || "";
}

function resolveSummaryMatrixSummary(quoteSurface, serviceStatus) {
  const serviceMatrix = serviceStatus?.quote?.matrixSummary;
  if (serviceMatrix && typeof serviceMatrix === "object") {
    return serviceMatrix;
  }
  return quoteSurface?.summary ?? {};
}

function resolveSummaryNextSafeTask(serviceStatus) {
  const next = String(serviceStatus?.nextSafeTask ?? "").trim();
  return (
    next ||
    "建立 Telegram /quote dry-run harness，驗證 handler 可直接產生並送出 fresh/blocked 回覆。"
  );
}

function globalMonitorNote(matrix, product) {
  if (product?.ready !== true || product?.status !== "fresh") {
    return "";
  }
  const summary = matrix?.summary ?? {};
  const freshCount = Number(summary.freshCount ?? 0);
  const productCount = Number(summary.productCount ?? 0);
  if (!Number.isFinite(freshCount) || !Number.isFinite(productCount) || productCount <= 0) {
    return "";
  }
  if (freshCount >= productCount) {
    return "全商品監控=全部就緒";
  }
  const products = Array.isArray(matrix?.products) ? matrix.products : [];
  const blockedGroups = new Map();
  for (const item of products) {
    if (item?.ready === true) {
      continue;
    }
    const status = String(item?.status || "not_ready");
    const id = item?.id || item?.matchedSymbol || item?.label;
    const group = blockedGroups.get(status) ?? [];
    if (id) {
      group.push(id);
    }
    blockedGroups.set(status, group);
  }
  const blockedSummary = [...blockedGroups.entries()]
    .map(([status, ids]) => `${status}${ids.length ? `(${ids.join(",")})` : ""}`)
    .join(",");
  return `本商品=可用｜全商品監控=另有${blockedSummary || "not_ready"}，不影響本商品即時回報`;
}

function productReply(product, queryText, matrix = null) {
  const quote = product?.quote ?? {};
  const symbol = product?.matchedSymbol || quote.stockNo || "--";
  const label = product?.label || quote.stockName || product?.id || "--";
  const alias = aliasNote(product, queryText);
  const monitorNote = globalMonitorNote(matrix, product);
  const contractRoute = product?.contractRoute;
  const routeNote = contractRoute
    ? `月份路由=${contractRoute.marketCode}/${contractRoute.routingMode}/${(contractRoute.selectedSymbols || []).join(",")}`
    : "";
  if (product?.ready === true && product?.status === "fresh") {
    return [
      `[OpenClaw 報價] ${label} ${symbol}${alias}`,
      "狀態=即時",
      routeNote,
      monitorNote,
      `買價=${formatNumber(quote.bid)}`,
      `賣價=${formatNumber(quote.ask)}`,
      `成交=${formatNumber(quote.close)}`,
      `延遲=${formatAge(product.ageSeconds)}`,
      `來源=${quote.eventSource || "--"}`,
      "真單=封鎖（風控未開啟）",
    ]
      .filter(Boolean)
      .join("｜");
  }
  if (product?.status === "session_closed") {
    return [
      `[OpenClaw 報價] ${label} ${symbol}${alias}`,
      "狀態=SESSION_CLOSED",
      routeNote,
      `原因=${reasonLabel(product)}`,
      `延遲=${formatAge(product?.ageSeconds)}`,
      "不可回舊價",
      "不可用於策略或下單",
      "真單=封鎖（風控未開啟）",
    ]
      .filter(Boolean)
      .join("｜");
  }
  return [
    `[OpenClaw 報價] ${label} ${symbol}${alias}`,
    `狀態=封鎖:${statusLabel(product?.status || "not_ready")}`,
    routeNote,
    `原因=${reasonLabel(product)}`,
    `買價=${formatNumber(quote.bid)}`,
    `賣價=${formatNumber(quote.ask)}`,
    `延遲=${formatAge(product?.ageSeconds)}`,
    "不可回舊價",
    "不可用於策略或下單",
    "真單=封鎖（風控未開啟）",
  ]
    .filter(Boolean)
    .join("｜");
}

function notFoundReply(queryText, matrix) {
  const products = Array.isArray(matrix?.products) ? matrix.products : [];
  const known = products
    .map((product) => product?.matchedSymbol || product?.id)
    .filter(Boolean)
    .join(",");
  return [
    `[OpenClaw 報價] 找不到商品=${queryText || "--"}`,
    `已知商品=${known || "無"}`,
    "不可回舊價",
    "真單=封鎖（風控未開啟）",
  ].join("｜");
}

export function parseQuoteQuery(input) {
  const raw = String(input ?? "").trim();
  const queryText = stripQuoteCommand(raw);
  return queryText || "";
}

function parseTelegramSemiQuery(queryText) {
  const raw = String(queryText ?? "").trim();
  if (!raw) {
    return null;
  }
  const match = raw.match(
    /^(?:semi|approval|半批准|半審批|人工審查|人工確認|審批|審查)(?:\s+(.+))?$/iu,
  );
  if (!match) {
    return null;
  }
  const tail = String(match[1] ?? "").trim();
  const tokens = tail ? tail.split(/\s+/u) : [];
  const head = tokens[0] ?? "";
  const callbackToken =
    tokens.find((token) => /^capital_semi_(approve|reject|refresh)_[a-f0-9]{16}$/iu.test(token)) ||
    "";
  const callbackActionMatch = callbackToken.match(
    /^capital_semi_(approve|reject|refresh)_[a-f0-9]{16}$/iu,
  );
  const callbackAction = callbackActionMatch?.[1]?.toLowerCase() ?? "";
  let action = "status";
  if (callbackAction === "approve" || /(approve|確認|同意|核准|批准)/iu.test(head)) {
    action = "approve";
  } else if (callbackAction === "reject" || /(reject|deny|拒絕|駁回)/iu.test(head)) {
    action = "reject";
  } else if (callbackAction === "refresh" || /(refresh|reload|重整|刷新)/iu.test(head)) {
    action = "refresh";
  }
  const filteredTokens = tokens.filter((token, index) => {
    if (token === callbackToken) {
      return false;
    }
    if (action !== "status" && index === 0) {
      return false;
    }
    return true;
  });
  const tailWithoutAction = filteredTokens.join(" ").trim();
  const orderText = tailWithoutAction || "模擬真單 台指近 多 1口";
  return {
    action,
    orderText,
    callbackData: callbackToken,
    writeReviewChecklist: (action === "approve" || action === "reject") && callbackToken.length > 0,
  };
}

async function buildCapitalQuoteTelegramSemiReplyReport(params) {
  const { inputQuery, parsedQuery, repoRoot, semiQuery } = params;
  const semiReport =
    semiQuery.action === "status"
      ? await buildCapitalTelegramSemiApprovalGate({
          repoRoot,
          text: semiQuery.orderText,
        })
      : await buildCapitalTelegramSemiApprovalCallback({
          repoRoot,
          text: semiQuery.orderText,
          action: semiQuery.action,
          callbackData: semiQuery.callbackData || "",
          writeReviewChecklist: semiQuery.writeReviewChecklist,
          writeState: true,
        });
  const blockerCode =
    Array.isArray(semiReport?.blockers) && semiReport.blockers.length > 0
      ? semiReport.blockers.join(",")
      : "";
  return {
    schema: "openclaw.capital.quote-telegram-reply.v1",
    generatedAt: new Date().toISOString(),
    query: inputQuery,
    parsedQuery,
    status: `semi_${semiReport?.status || "unknown"}`,
    language: "zh-TW",
    freshMatched: false,
    blockerCode,
    safety: {
      readOnly: semiQuery.writeReviewChecklist !== true,
      loginAttempted: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      realOrderAllowed: false,
      writesReviewChecklist: semiQuery.writeReviewChecklist === true,
      callbackTokenPresent: Boolean(semiQuery.callbackData),
    },
    semiApproval: {
      action: semiQuery.action,
      orderText: semiQuery.orderText,
      callbackData: semiQuery.callbackData || "",
      report: semiReport,
    },
    replyText:
      typeof semiReport?.replyText === "string" && semiReport.replyText.trim()
        ? semiReport.replyText.trim()
        : "[OpenClaw SEMI] 封鎖：SEMI 回覆內容缺失｜真單=封鎖｜sentOrder=false",
    nextSafeTask:
      typeof semiReport?.nextSafeTask === "string" && semiReport.nextSafeTask.trim()
        ? semiReport.nextSafeTask.trim()
        : "先補齊 Telegram SEMI callback 寫入鏈路，再重跑 capital:telegram:semi-callback:check。",
  };
}

export function buildCapitalQuoteTelegramReply(
  matrix,
  input = "",
  serviceStatus = null,
  automationState = null,
  contractRouter = null,
) {
  const quoteSurface = quoteMatrix(matrix);
  const queryText = parseQuoteQuery(input);
  const productQueryText = normalizeNaturalProductQuery(queryText);
  const safety = {
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    realOrderAllowed: false,
  };
  const serviceBlocker = resolveServiceStatusBlocker(serviceStatus);
  if (isTelegramOwnerQuery(queryText)) {
    const ownerCheck = buildCapitalTelegramOwnerCheck(serviceStatus);
    return {
      schema: "openclaw.capital.quote-telegram-reply.v1",
      generatedAt: new Date().toISOString(),
      query: input,
      parsedQuery: queryText,
      status: ownerCheck.ready
        ? "telegram_owner_ready"
        : `blocked_${ownerCheck.blockerCode || ownerCheck.status}`,
      language: "zh-TW",
      freshMatched: false,
      blockerCode: ownerCheck.ready ? "" : ownerCheck.blockerCode || ownerCheck.status,
      ownerCheck,
      safety,
      replyText: ownerCheck.replyLine,
      nextSafeTask: ownerCheck.nextSafeTask,
    };
  }
  if (serviceBlocker) {
    return {
      schema: "openclaw.capital.quote-telegram-reply.v1",
      generatedAt: new Date().toISOString(),
      query: input,
      parsedQuery: queryText,
      status: `blocked_${serviceBlocker.code}`,
      language: "zh-TW",
      freshMatched: false,
      blockerCode: serviceBlocker.code,
      serviceStatus,
      safety,
      replyText: serviceBlockedReply(queryText, serviceBlocker),
      nextSafeTask:
        "用不帶 --telegram-polling 的方式重啟 CapitalHftService，讓 OpenClaw Gateway 成為唯一 Telegram getUpdates owner。",
    };
  }
  const contractMonthRequest = resolveContractMonthQuery(queryText);
  const contractRoute = contractMonthRequest
    ? findContractRoute(contractRouter, contractMonthRequest)
    : null;
  if (contractMonthRequest) {
    const routeProduct = contractRoute
      ? findProductByRouteSymbols(quoteSurface, contractRoute)
      : null;
    const effectiveProduct = applyServiceSessionClosed(
      routeProduct
        ? applyContractRouteToProduct(routeProduct, contractRoute)
        : productFromContractRoute(
            contractRoute || {
              marketCode: contractMonthRequest.marketCode,
              routingMode: contractMonthRequest.routingMode,
              routeStatus: "blocked",
              quoteReadiness: "blocked",
              blockerCode: "contract_month_router_missing",
              reason: "contract-month-router 沒有產生此商品的當月路由。",
              selectedSymbols: [],
            },
          ),
      serviceStatus,
    );
    const status =
      effectiveProduct.ready === true && effectiveProduct.status === "fresh"
        ? "matched_fresh"
        : effectiveProduct.status === "session_closed"
          ? "session_closed"
          : `blocked_${effectiveProduct.status || "not_ready"}`;
    return {
      schema: "openclaw.capital.quote-telegram-reply.v1",
      generatedAt: new Date().toISOString(),
      query: input,
      parsedQuery: queryText,
      normalizedProductQuery: productQueryText,
      contractMonthRequest,
      contractRoute,
      status,
      language: "zh-TW",
      freshMatched: status === "matched_fresh",
      blockerCode: status === "matched_fresh" ? "" : effectiveProduct.status || "not_ready",
      product: effectiveProduct,
      safety,
      replyText: productReply(effectiveProduct, productQueryText, quoteSurface),
      nextSafeTask:
        status === "matched_fresh"
          ? "把策略引擎商品解析也接到 contract-month-router，避免策略層回退 TX00 熱月。"
          : "訂閱月份路由列出的商品代號並等待 fresh matched callback；不可用熱月代號替代當月查詢。",
    };
  }
  const product = findProductByQuery(quoteSurface, productQueryText);
  if (product) {
    const effectiveProduct = applyServiceSessionClosed(product, serviceStatus);
    const status =
      effectiveProduct.ready === true && effectiveProduct.status === "fresh"
        ? "matched_fresh"
        : effectiveProduct.status === "session_closed"
          ? "session_closed"
          : `blocked_${effectiveProduct.status || "not_ready"}`;
    return {
      schema: "openclaw.capital.quote-telegram-reply.v1",
      generatedAt: new Date().toISOString(),
      query: input,
      parsedQuery: queryText,
      normalizedProductQuery: productQueryText,
      status,
      language: "zh-TW",
      freshMatched: status === "matched_fresh",
      blockerCode: status === "matched_fresh" ? "" : effectiveProduct.status || "not_ready",
      product: effectiveProduct,
      safety,
      replyText: productReply(effectiveProduct, productQueryText, quoteSurface),
      nextSafeTask:
        status === "session_closed"
          ? "等待國內期貨交易時段恢復後確認 fresh callback；期間不可回舊價。"
          : "建立 Telegram /quote dry-run harness，驗證 handler 可直接產生並送出 fresh/blocked 回覆。",
    };
  }
  const knownFallbackProduct = knownFallbackProductByQuery(productQueryText);
  if (knownFallbackProduct) {
    return {
      schema: "openclaw.capital.quote-telegram-reply.v1",
      generatedAt: new Date().toISOString(),
      query: input,
      parsedQuery: queryText,
      normalizedProductQuery: productQueryText,
      status: `blocked_${knownFallbackProduct.status}`,
      language: "zh-TW",
      freshMatched: false,
      blockerCode: knownFallbackProduct.status,
      product: knownFallbackProduct,
      safety,
      replyText: productReply(knownFallbackProduct, productQueryText, quoteSurface),
      nextSafeTask:
        "把此商品加入 CapitalHftService 海外訂閱清單並驗證官方 SKOSQuoteLib callback 回流。",
    };
  }
  if (SUMMARY_TERMS.has(normalizeSearchText(queryText))) {
    const summaryBlockerCode = resolveSummaryBlockerCode(serviceStatus);
    return {
      schema: "openclaw.capital.quote-telegram-reply.v1",
      generatedAt: new Date().toISOString(),
      query: input,
      parsedQuery: queryText,
      status: "summary",
      language: "zh-TW",
      freshMatched: false,
      blockerCode: summaryBlockerCode,
      matrixSummary: resolveSummaryMatrixSummary(quoteSurface, serviceStatus),
      safety,
      serviceStatus,
      automationState,
      replyText: summarizeMatrix(quoteSurface, serviceStatus, automationState),
      nextSafeTask: resolveSummaryNextSafeTask(serviceStatus),
    };
  }
  return {
    schema: "openclaw.capital.quote-telegram-reply.v1",
    generatedAt: new Date().toISOString(),
    query: input,
    parsedQuery: queryText,
    status: "not_found",
    language: "zh-TW",
    freshMatched: false,
    blockerCode: "symbol_not_found",
    safety,
    replyText: notFoundReply(queryText, quoteSurface),
    nextSafeTask: "補商品 mapping 或確認券商實際回流代號。",
  };
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const options = {
    query: "",
    symbol: "",
    repoRoot: process.cwd(),
    matrix: "",
    reportableState: "",
    refreshReportable: true,
    output: DEFAULT_STATE_PATH,
    writeState: false,
    json: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--query") {
      options.query = argv[++index] ?? "";
    } else if (arg.startsWith("--query=")) {
      options.query = arg.slice("--query=".length);
    } else if (arg === "--symbol") {
      options.symbol = argv[++index] ?? "";
    } else if (arg.startsWith("--symbol=")) {
      options.symbol = arg.slice("--symbol=".length);
    } else if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--matrix") {
      options.matrix = argv[++index] ?? "";
    } else if (arg.startsWith("--matrix=")) {
      options.matrix = arg.slice("--matrix=".length);
    } else if (arg === "--reportable-state") {
      options.reportableState = argv[++index] ?? "";
    } else if (arg.startsWith("--reportable-state=")) {
      options.reportableState = arg.slice("--reportable-state=".length);
    } else if (arg === "--no-refresh") {
      options.refreshReportable = false;
    } else if (arg === "--output") {
      options.output = argv[++index] ?? options.output;
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      positional.push(arg);
    }
  }
  if (!options.query && options.symbol) {
    options.query = options.symbol;
  }
  if (!options.query && positional.length > 0) {
    options.query = positional.join(" ");
  }
  return options;
}

async function loadMatrix(options) {
  if (options.preferCoreMatrix === true) {
    try {
      return await readCapitalCoreProductFreshnessMatrix({ repoRoot: options.repoRoot });
    } catch {
      // Fall through to reportable/legacy sources when core matrix is unavailable.
    }
  }
  if (options.reportableState) {
    return readJson(path.resolve(options.reportableState));
  }
  if (options.matrix) {
    return readJson(path.resolve(options.matrix));
  }
  if (options.refreshReportable !== false) {
    const refreshed = await refreshCapitalReportableQuoteState({
      repoRoot: options.repoRoot,
      writeState: true,
    });
    if (refreshed.steps?.reportable?.outputPath) {
      return readJson(refreshed.steps.reportable.outputPath);
    }
  }
  try {
    return await readJson(
      path.resolve(options.repoRoot || process.cwd(), DEFAULT_REPORTABLE_STATE_PATH),
    );
  } catch {
    // Fall through to the legacy matrix until every caller has generated reportable quote state.
  }
  return readCapitalCoreProductFreshnessMatrix({ repoRoot: options.repoRoot });
}

async function loadServiceStatus(repoRoot) {
  try {
    return await readCapitalServiceStatus({ repoRoot });
  } catch {
    return null;
  }
}

async function loadAutomationState() {
  try {
    return await readJson(DEFAULT_AUTOMATION_STATE_PATH);
  } catch {
    return null;
  }
}

async function loadContractMonthRouter(options) {
  try {
    return await buildCapitalContractMonthRouter({
      reportableState:
        options.reportableState ||
        path.resolve(options.repoRoot || process.cwd(), DEFAULT_REPORTABLE_STATE_PATH),
    });
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const inputQuery = options.query || "/quote";
  const parsedQuery = parseQuoteQuery(inputQuery);
  const preferCoreMatrix = SUMMARY_TERMS.has(normalizeSearchText(parsedQuery));
  const matrix = await loadMatrix({ ...options, repoRoot, preferCoreMatrix });
  const serviceStatus = await loadServiceStatus(repoRoot);
  const automationState = await loadAutomationState();
  const contractRouter = await loadContractMonthRouter({ ...options, repoRoot });
  const semiQuery = parseTelegramSemiQuery(parsedQuery);
  const report = semiQuery
    ? await buildCapitalQuoteTelegramSemiReplyReport({
        inputQuery,
        parsedQuery,
        repoRoot,
        semiQuery,
      })
    : buildCapitalQuoteTelegramReply(
        matrix,
        inputQuery,
        serviceStatus,
        automationState,
        contractRouter,
      );
  if (options.writeState) {
    await writeJson(path.resolve(repoRoot, options.output), report);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report.replyText}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital quote telegram reply failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
