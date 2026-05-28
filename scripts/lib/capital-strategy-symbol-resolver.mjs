import { buildCapitalContractMonthRouter } from "../openclaw-capital-contract-month-router.mjs";
import { readCapitalCoreProductFreshnessMatrix } from "../openclaw-capital-core-product-freshness-matrix.mjs";

const DEFAULT_PRODUCT_ID = "tx-front";
const PRODUCT_QUERY_TO_ID = new Map([
  ["TX-FRONT", DEFAULT_PRODUCT_ID],
  ["TX_FRONT", DEFAULT_PRODUCT_ID],
  ["TXFRONT", DEFAULT_PRODUCT_ID],
  ["TXF", DEFAULT_PRODUCT_ID],
  ["TXFR1", DEFAULT_PRODUCT_ID],
  ["TX00", DEFAULT_PRODUCT_ID],
  ["台指近", DEFAULT_PRODUCT_ID],
  ["台指期近", DEFAULT_PRODUCT_ID],
]);

const CONTRACT_MONTH_QUERY_PATTERN =
  /^(?<market>[A-Z0-9]+)(?<mode>CURRENTMONTH|CURRENT|NEXTMONTH|NEXT|當月|下月|下個月|次月)$/u;

const STRATEGY_BLOCKED_LEGACY_SESSION_ALIASES = new Set(["TX00AM", "TX00PM", "TX06AM", "TX06PM"]);

export function normalizeStrategySymbolQuery(value) {
  return String(value ?? DEFAULT_PRODUCT_ID)
    .trim()
    .toUpperCase()
    .replace(/\s+/gu, "");
}

function compactStrategySymbolQuery(value) {
  return normalizeStrategySymbolQuery(value).replace(/[-_]/gu, "");
}

function parseContractMonthStrategyQuery(value) {
  const compact = compactStrategySymbolQuery(value);
  const match = compact.match(CONTRACT_MONTH_QUERY_PATTERN);
  if (!match?.groups) {
    return null;
  }
  const rawMode = match.groups.mode;
  return {
    marketCode: match.groups.market,
    routingMode: ["NEXTMONTH", "NEXT", "下月", "下個月", "次月"].includes(rawMode)
      ? "next-month"
      : "current-month",
  };
}

function productForQuery(matrix, query) {
  const normalized = normalizeStrategySymbolQuery(query);
  if (STRATEGY_BLOCKED_LEGACY_SESSION_ALIASES.has(normalized)) {
    return null;
  }
  const productId = PRODUCT_QUERY_TO_ID.get(normalized) ?? normalized;
  const products = Array.isArray(matrix?.products) ? matrix.products : [];
  return products.find((product) => {
    if (product?.id === productId) {
      return true;
    }
    if (normalizeStrategySymbolQuery(product?.label) === normalized) {
      return true;
    }
    if (normalizeStrategySymbolQuery(product?.matchedSymbol) === normalized) {
      return true;
    }
    return (
      Array.isArray(product?.aliases) &&
      product.aliases.some((alias) => {
        const aliasSymbol = normalizeStrategySymbolQuery(alias?.symbol);
        return (
          aliasSymbol === normalized && !STRATEGY_BLOCKED_LEGACY_SESSION_ALIASES.has(aliasSymbol)
        );
      })
    );
  });
}

function sanitizeStrategyResolverDiagnostic(diagnostic) {
  if (!diagnostic || typeof diagnostic !== "object") {
    return diagnostic;
  }
  const next = { ...diagnostic };
  if (Array.isArray(next.aliasStates)) {
    next.aliasStates = next.aliasStates.filter(
      (aliasState) =>
        !STRATEGY_BLOCKED_LEGACY_SESSION_ALIASES.has(
          normalizeStrategySymbolQuery(aliasState?.symbol),
        ),
    );
  }
  return next;
}

export async function resolveCapitalStrategySymbol(options = {}) {
  const requestedSymbol = options.query ?? DEFAULT_PRODUCT_ID;
  const contractMonthQuery = parseContractMonthStrategyQuery(requestedSymbol);
  if (contractMonthQuery) {
    const router = await buildCapitalContractMonthRouter({
      now: options.now,
      repoRoot: options.repoRoot,
      reportableState: options.reportableState,
      instrumentRegistry: options.instrumentRegistry,
      marketCode: contractMonthQuery.marketCode,
      mode: contractMonthQuery.routingMode,
    });
    const route =
      router.routes.find(
        (item) =>
          item.marketCode === contractMonthQuery.marketCode &&
          item.routingMode === contractMonthQuery.routingMode,
      ) ?? router.routes[0];
    const freshEvidence = route?.liveEvidence?.find((item) => item.status === "fresh_reportable");
    const ok = route?.routeStatus === "resolved" && route?.quoteReadiness === "fresh_matched";
    return {
      ok,
      requestedSymbol,
      resolvedSymbol: ok
        ? freshEvidence?.symbol || route.selectedSymbols?.[0] || ""
        : route?.selectedSymbols?.[0] || "",
      productId: `${route?.marketCode || contractMonthQuery.marketCode}-${contractMonthQuery.routingMode}`,
      status: ok ? "fresh_matched" : route?.quoteReadiness || route?.routeStatus || "blocked",
      reason: ok
        ? "Contract-month route is resolved and fresh matched."
        : route?.reason ||
          "Contract-month route is not resolved + fresh matched; strategy must stay blocked.",
      label: route?.productName || contractMonthQuery.marketCode,
      ageSeconds: null,
      contractRoute: route,
      strategyModulePolicy: route?.strategyModulePolicy || null,
      sourceStateDir: router.reportableStatePath,
    };
  }
  const normalized = normalizeStrategySymbolQuery(requestedSymbol);
  if (STRATEGY_BLOCKED_LEGACY_SESSION_ALIASES.has(normalized)) {
    return {
      ok: false,
      requestedSymbol,
      resolvedSymbol: "",
      productId: "",
      status: "invalid_legacy_session_alias",
      reason: `${normalized} is a legacy session alias and must not be used as an active strategy symbol; use TX00/TX06 or a product route such as tx-front.`,
    };
  }
  const mappedProductId = PRODUCT_QUERY_TO_ID.get(normalized);
  const mustUseProductResolver =
    mappedProductId === DEFAULT_PRODUCT_ID || normalized === DEFAULT_PRODUCT_ID.toUpperCase();

  if (!mustUseProductResolver) {
    return {
      ok: true,
      requestedSymbol,
      resolvedSymbol: normalized,
      productId: "",
      status: "explicit_symbol",
      reason: "Explicit symbol is not a known product alias; using it as-is.",
    };
  }

  const matrix = await readCapitalCoreProductFreshnessMatrix({
    repoRoot: options.repoRoot,
    stateDir: options.stateDir,
    maxFreshSeconds: options.maxFreshSeconds,
  });
  const product =
    productForQuery(matrix, requestedSymbol) ?? productForQuery(matrix, DEFAULT_PRODUCT_ID);
  if (!product) {
    return {
      ok: false,
      requestedSymbol,
      resolvedSymbol: "",
      productId: DEFAULT_PRODUCT_ID,
      status: "missing_product_mapping",
      reason: "Core freshness matrix has no tx-front product.",
      matrixStatus: matrix.status,
    };
  }
  if (product.ready === true && product.status === "fresh" && product.matchedSymbol) {
    return {
      ok: true,
      requestedSymbol,
      resolvedSymbol: product.matchedSymbol,
      productId: product.id,
      status: product.status,
      reason: product.reason,
      label: product.label,
      ageSeconds: product.ageSeconds,
      sourceStateDir: matrix.sourceStateDir,
    };
  }
  return {
    ok: false,
    requestedSymbol,
    resolvedSymbol: product.matchedSymbol || "",
    productId: product.id,
    status: product.status,
    reason: product.reason,
    label: product.label,
    ageSeconds: product.ageSeconds,
    diagnostic: sanitizeStrategyResolverDiagnostic(product.diagnostic),
    sourceStateDir: matrix.sourceStateDir,
  };
}
