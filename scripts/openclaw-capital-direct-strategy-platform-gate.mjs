#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/brokerdesk-state-dir.mjs";
import {
  buildCapitalCurrentPaperIntentsFromTargetRegistry,
  writeCapitalCurrentPaperIntentsState,
} from "./openclaw-capital-current-paper-intents-from-target-registry.mjs";
import { buildCapitalDirectOperationInputs } from "./openclaw-capital-direct-operation-inputs.mjs";
import { buildCapitalDirectOperationStatus } from "./openclaw-capital-direct-operation-status.mjs";
import { runCapitalPaperFillSimulation } from "./openclaw-capital-paper-fill-simulator.mjs";
import { runCapitalPaperOutcomeLedger } from "./openclaw-capital-paper-outcome-ledger.mjs";
import { runCapitalPaperStrategyEvaluator } from "./openclaw-capital-paper-strategy-evaluator.mjs";
import { runStrategyFillSimulation } from "./openclaw-capital-strategy-fill-simulator.mjs";
import { writeCapitalStrategyTailRiskRepairPlan } from "./openclaw-capital-strategy-tail-risk-repair.mjs";

const SCHEMA = "openclaw.capital.direct-strategy-platform-gate.v1";
const ALLOWED_STATUSES = new Set([
  "blocked_quote_not_fresh",
  "blocked_operator_inputs_required",
  "blocked_paper_strategy_not_promoted",
  "blocked_live_promotion_required",
]);
const BROKERDESK_DYNAMIC_TARGET_LIMIT = 96;
const PAPER_ONLY_BROKERDESK_ROUTE_INSTRUMENTS = new Set([
  "6C",
  "AP",
  "BO",
  "BZ",
  "CD",
  "CL",
  "DAX",
  "DXM",
  "DXS",
  "ES",
  "FV",
  "GC",
  "HG",
  "M2K",
  "MCL",
  "MES",
  "MGC",
  "MNQ",
  "MYM",
  "NK",
  "NQ",
  "QM",
  "RTY",
  "SI",
  "SM",
  "TN",
  "TU",
  "TY",
  "UB",
  "US",
  "YM",
]);
const DEFAULT_PLATFORM_TARGETS = [
  {
    id: "a50-direct-request",
    label: "A50 202605 direct test",
    marketCode: "A50",
    routingMode: "hot-month",
    quoteSymbol: "CN0000",
    orderInstrument: "A50 202605",
    strategyFamilies: ["opening_range", "vwap_reversion", "trend_following"],
  },
  {
    id: "txf-current-month",
    label: "台指期當月",
    marketCode: "TXF",
    routingMode: "current-month",
    coreProductId: "tx-front",
    strategyFamilies: ["opening_range", "trend_following", "mean_reversion"],
  },
  {
    id: "txf-front-month",
    label: "台指期近月",
    marketCode: "TXF",
    routingMode: "front-month",
    coreProductId: "tx-front",
    strategyFamilies: ["opening_range", "vwap_reversion"],
  },
  {
    id: "a50-current-month",
    label: "A50 當月",
    marketCode: "A50",
    routingMode: "current-month",
    coreProductId: "a50-hot",
    strategyFamilies: ["trend_following", "vwap_reversion"],
  },
  {
    id: "a50-hot-month",
    label: "A50 熱月",
    marketCode: "A50",
    routingMode: "hot-month",
    coreProductId: "a50-hot",
    strategyFamilies: ["trend_following", "vwap_reversion"],
  },
  {
    id: "cl-hot-month",
    label: "輕原油熱月",
    marketCode: "CL",
    routingMode: "hot-month",
    coreProductId: "crude-oil-hot",
    strategyFamilies: ["trend_following", "breakout"],
  },
  {
    id: "nq-next-month",
    label: "Nasdaq 100 下月",
    marketCode: "NQ",
    routingMode: "next-month",
    coreProductId: "nasdaq-hot",
    strategyFamilies: ["trend_following", "opening_range"],
  },
  {
    id: "es-next-month",
    label: "S&P 500 下月",
    marketCode: "ES",
    routingMode: "next-month",
    coreProductId: "sp500-hot",
    strategyFamilies: ["trend_following", "opening_range"],
  },
  {
    id: "gc-hot-month",
    label: "黃金熱月",
    marketCode: "GC",
    routingMode: "hot-month",
    coreProductId: "gold-hot",
    strategyFamilies: ["trend_following", "mean_reversion"],
  },
];

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonIfExists(filePath) {
  try {
    const text = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "").trim();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const options = {
    check: false,
    json: false,
    writeState: false,
  };
  for (const arg of argv) {
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-state") {
      options.writeState = true;
    }
  }
  return options;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampAgeSeconds(value, nowMs) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

function isFreshTimestamp(value, nowMs, maxFreshSeconds) {
  const age = timestampAgeSeconds(value, nowMs);
  return age !== null && age <= maxFreshSeconds;
}

function normalizedSymbol(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function uniqueNormalizedSymbols(values) {
  const seen = new Set();
  const symbols = [];
  for (const value of values) {
    const symbol = normalizedSymbol(value);
    if (!symbol || seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);
    symbols.push(symbol);
  }
  return symbols;
}

function normalizeBlocker(blocker, prefix = "") {
  if (typeof blocker === "string" && blocker.trim()) {
    return prefix ? `${prefix}:${blocker.trim()}` : blocker.trim();
  }
  if (blocker && typeof blocker === "object") {
    const id = typeof blocker.id === "string" && blocker.id.trim() ? blocker.id.trim() : "";
    const message =
      typeof blocker.message === "string" && blocker.message.trim() ? blocker.message.trim() : "";
    const value = id || message || JSON.stringify(blocker);
    return prefix ? `${prefix}:${value}` : value;
  }
  return "";
}

function uniqueBlockers(...groups) {
  return [
    ...new Set(
      groups
        .flat()
        .map((item) => normalizeBlocker(item))
        .filter(Boolean),
    ),
  ];
}

export function strategyRuleBlockers(evaluator) {
  if (evaluator?.recommendation === "promote") {
    return [];
  }
  return safeArray(evaluator?.failedRules).map((rule) =>
    normalizeBlocker(rule?.id ? `strategy_rule:${rule.id}` : rule, ""),
  );
}

function strategyFillGateBlockers(strategyFill) {
  return safeArray(strategyFill?.promotionGate?.blockedReasons).map((reason) =>
    normalizeBlocker(reason, "strategy_fill_gate"),
  );
}

export function buildPlatformQuoteFreshnessSummary({
  directStatus,
  targetRegistry,
  currentPaperIntents,
}) {
  const quote = directStatus?.summary?.quote ?? {};
  const activeUniverse = safeArray(targetRegistry?.activeUniverse);
  const freshPaperTargets = activeUniverse.filter(
    (target) => target?.wallClockFresh === true && target?.canGeneratePaperIntent === true,
  );
  const generatedIntentCount = Number(
    currentPaperIntents?.targetRegistry?.generatedIntentCount ??
      currentPaperIntents?.intentWrite?.activeIntentsRecordCount ??
      0,
  );
  const currentPaperIntentsFresh =
    currentPaperIntents?.status === "current_paper_intents_written" && generatedIntentCount > 0;
  const directA50Fresh = quote.a50Status === "fresh";
  const multiTargetFresh = currentPaperIntentsFresh && freshPaperTargets.length > 0;
  const overallFreshness = directA50Fresh
    ? "a50_fresh"
    : multiTargetFresh
      ? "multi_target_fresh"
      : "blocked";
  return {
    overallFreshness,
    strategyQuoteReady: directA50Fresh || multiTargetFresh,
    directA50Fresh,
    multiTargetFresh,
    currentPaperIntentsFresh,
    generatedIntentCount,
    freshPaperTargetCount: freshPaperTargets.length,
    freshPaperSymbols: freshPaperTargets.map((target) => target.quoteSymbol).filter(Boolean),
    freshPaperTargetIds: freshPaperTargets.map((target) => target.id).filter(Boolean),
    brokerDeskDynamicTargetCount: Number(
      targetRegistry?.summary?.brokerDeskDynamicTargetCount ?? 0,
    ),
    noLiveOrderSent: true,
  };
}

function computeStatus({ directStatus, paperFill, strategyFill, evaluator, quoteFreshness }) {
  const position = directStatus.summary?.position ?? {};
  const ack = directStatus.summary?.externalBrokerAdapter ?? {};
  if (quoteFreshness?.strategyQuoteReady !== true) {
    return "blocked_quote_not_fresh";
  }
  if (
    paperFill.status !== "ok" ||
    strategyFill.recommendation !== "promote" ||
    evaluator.recommendation !== "promote"
  ) {
    return "blocked_paper_strategy_not_promoted";
  }
  if (position.usable !== true || ack.ackUsable !== true) {
    return "blocked_operator_inputs_required";
  }
  return "blocked_live_promotion_required";
}

function routeForTarget(routes, target) {
  return safeArray(routes).find(
    (route) => route?.marketCode === target.marketCode && route?.routingMode === target.routingMode,
  );
}

function productForTarget(products, target) {
  if (!target.coreProductId) {
    return null;
  }
  return safeArray(products).find((product) => product?.id === target.coreProductId) ?? null;
}

function brokerDeskSymbolInstrument(symbol, entry) {
  const instrument = normalizedSymbol(entry?.instrument);
  if (instrument) {
    return instrument;
  }
  return normalizedSymbol(symbol).replace(/\d{4}$/u, "");
}

function brokerDeskStrategyFamilies(instrument) {
  if (["CL", "MCL", "QM", "BZ", "NG", "QG", "RB", "HO"].includes(instrument)) {
    return ["trend_following", "breakout"];
  }
  if (["GC", "MGC", "SI", "HG"].includes(instrument)) {
    return ["trend_following", "mean_reversion"];
  }
  if (["ES", "MES", "NQ", "MNQ", "YM", "MYM", "RTY", "M2K"].includes(instrument)) {
    return ["trend_following", "opening_range"];
  }
  return ["trend_following"];
}

function brokerDeskDynamicTargetId(symbol) {
  return `brokerdesk-fresh-${normalizedSymbol(symbol)
    .replace(/[^A-Z0-9]+/gu, "-")
    .toLowerCase()}`;
}

function isFreshBrokerDeskSymbolCacheEntry(entry, nowMs, maxFreshSeconds = 300) {
  const bid = finiteNumber(entry?.bid);
  const ask = finiteNumber(entry?.ask);
  const price = finiteNumber(entry?.price);
  const ageSeconds = timestampAgeSeconds(entry?.time ?? entry?.receivedAt, nowMs);
  return (
    bid !== null &&
    ask !== null &&
    price !== null &&
    bid > 0 &&
    ask > 0 &&
    price > 0 &&
    ageSeconds !== null &&
    ageSeconds <= maxFreshSeconds
  );
}

function buildBrokerDeskDynamicTargets({ osSymbolCache, nowMs }) {
  const maxFreshSeconds = 300;
  if (!isFreshTimestamp(osSymbolCache?.generatedAt, nowMs, maxFreshSeconds)) {
    return [];
  }
  const defaultSymbols = new Set(
    DEFAULT_PLATFORM_TARGETS.flatMap((target) =>
      uniqueNormalizedSymbols([target.quoteSymbol, ...safeArray(target.selectedSymbols)]),
    ),
  );
  return Object.entries(osSymbolCache?.symbols ?? {})
    .map(([symbol, entry]) => ({
      symbol: normalizedSymbol(symbol),
      entry,
      receivedAt: String(entry?.time ?? entry?.receivedAt ?? ""),
    }))
    .filter(({ symbol, entry }) => {
      return (
        symbol &&
        !defaultSymbols.has(symbol) &&
        isFreshBrokerDeskSymbolCacheEntry(entry, nowMs, maxFreshSeconds)
      );
    })
    .toSorted((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))
    .slice(0, BROKERDESK_DYNAMIC_TARGET_LIMIT)
    .map(({ symbol, entry }) => {
      const instrument = brokerDeskSymbolInstrument(symbol, entry);
      return {
        id: brokerDeskDynamicTargetId(symbol),
        label: String(entry?.name ?? `BrokerDesk ${symbol}`),
        marketCode: instrument,
        routingMode: symbol.endsWith("0000") ? "hot-month" : "brokerdesk-contract",
        quoteSymbol: symbol,
        selectedSymbols: [symbol],
        targetSource: "brokerdesk_os_symbol_cache",
        brokerDeskFresh: true,
        brokerDeskReceivedAt: String(entry?.time ?? entry?.receivedAt ?? ""),
        brokerDeskAgeSeconds: timestampAgeSeconds(entry?.time ?? entry?.receivedAt, nowMs),
        strategyFamilies: brokerDeskStrategyFamilies(instrument),
      };
    });
}

function firstLiveEvidence(route) {
  return (
    safeArray(route?.liveEvidence).find((item) => item?.status === "fresh_reportable") ??
    safeArray(route?.liveEvidence)[0] ??
    null
  );
}

function coreProductFreshness(coreMatrix, coreProduct, nowMs) {
  const quote = coreProduct?.quote ?? {};
  const ageSeconds = finiteNumber(coreProduct?.ageSeconds);
  const maxFreshSeconds =
    finiteNumber(coreProduct?.maxFreshSeconds) ?? finiteNumber(coreMatrix?.maxFreshSeconds) ?? 300;
  const wallClockAgeSeconds = timestampAgeSeconds(quote.receivedAt, nowMs);
  const matrixAgeSeconds = timestampAgeSeconds(coreMatrix?.generatedAt, nowMs);
  const fresh =
    coreProduct?.ready === true &&
    coreProduct?.status === "fresh" &&
    ageSeconds !== null &&
    ageSeconds <= maxFreshSeconds &&
    isFreshTimestamp(quote.receivedAt, nowMs, maxFreshSeconds) &&
    isFreshTimestamp(coreMatrix?.generatedAt, nowMs, maxFreshSeconds);
  return {
    fresh,
    ageSeconds,
    wallClockAgeSeconds,
    matrixAgeSeconds,
    maxFreshSeconds,
    receivedAt: quote.receivedAt ?? "",
    status: coreProduct?.status ?? "",
  };
}

function targetReadiness({ target, route, coreProduct, coreFreshness, directStatus }) {
  const directQuote = directStatus.summary?.quote ?? {};
  const isDirectA50 =
    target.quoteSymbol === directStatus.summary?.requestedTrade?.quoteSymbol &&
    target.orderInstrument === directStatus.summary?.requestedTrade?.instrument;
  if (route?.strategyModulePolicy?.canGeneratePaperIntent === true) {
    return "ready_for_current_paper_intent";
  }
  if (brokerDeskPaperExecutionEligible({ target, route })) {
    return "ready_for_current_paper_intent";
  }
  if (isDirectA50 && directQuote.a50Status === "fresh") {
    return "quote_fresh_but_strategy_route_blocked";
  }
  if (target.brokerDeskFresh === true) {
    return "quote_fresh_but_strategy_route_blocked";
  }
  if (coreFreshness.fresh === true) {
    return "core_quote_fresh_route_blocked";
  }
  if (coreProduct?.status === "fresh" && coreFreshness.fresh !== true) {
    return "core_quote_stale_wall_clock";
  }
  return route?.quoteReadiness || route?.routeStatus || coreProduct?.status || "missing_route";
}

function brokerDeskPaperExecutionEligible({ target, route }) {
  const paperOnlyStaticRoute =
    target?.brokerDeskFresh === true &&
    PAPER_ONLY_BROKERDESK_ROUTE_INSTRUMENTS.has(normalizedSymbol(target?.marketCode));
  return (
    target?.brokerDeskFresh === true &&
    (route?.routeStatus === "resolved" || paperOnlyStaticRoute) &&
    Number.isFinite(Number(target?.brokerDeskAgeSeconds)) &&
    Number(target.brokerDeskAgeSeconds) >= 0 &&
    Number(target.brokerDeskAgeSeconds) <= 300
  );
}

function buildTargetRegistry({ repoRoot, router, coreMatrix, directStatus, osSymbolCache, nowMs }) {
  const routes = safeArray(router?.routes);
  const products = safeArray(coreMatrix?.products);
  const dynamicTargets = buildBrokerDeskDynamicTargets({ osSymbolCache, nowMs });
  const activeUniverse = [...DEFAULT_PLATFORM_TARGETS, ...dynamicTargets].map((target) => {
    const route = routeForTarget(routes, target);
    const coreProduct = productForTarget(products, target);
    const coreFreshness = coreProductFreshness(coreMatrix, coreProduct, nowMs);
    const evidence = firstLiveEvidence(route);
    const brokerDeskPaperEligible = brokerDeskPaperExecutionEligible({ target, route });
    const readiness = targetReadiness({
      target,
      route,
      coreProduct,
      coreFreshness,
      directStatus,
    });
    const directQuote = directStatus.summary?.quote ?? {};
    const directA50Fresh =
      target.quoteSymbol === directStatus.summary?.requestedTrade?.quoteSymbol &&
      target.orderInstrument === directStatus.summary?.requestedTrade?.instrument &&
      directQuote.a50Status === "fresh";
    const targetWallClockFresh = directA50Fresh || coreFreshness.fresh;
    const selectedSymbols =
      target.brokerDeskFresh === true
        ? uniqueNormalizedSymbols([...safeArray(target.selectedSymbols), target.quoteSymbol])
        : uniqueNormalizedSymbols([
            ...safeArray(route?.selectedSymbols),
            ...safeArray(target.selectedSymbols),
            target.quoteSymbol,
          ]);
    return {
      id: target.id,
      label: target.label,
      marketCode: target.marketCode,
      routingMode: target.routingMode,
      targetSource: target.targetSource ?? "platform_default",
      coreProductId: target.coreProductId ?? "",
      orderInstrument: target.orderInstrument ?? "",
      quoteSymbol: target.quoteSymbol ?? evidence?.symbol ?? coreProduct?.matchedSymbol ?? "",
      selectedSymbols,
      routeStatus:
        route?.routeStatus ??
        (brokerDeskPaperEligible
          ? "resolved"
          : target.brokerDeskFresh
            ? "brokerdesk_cache_only"
            : "missing_route"),
      quoteReadiness:
        route?.quoteReadiness ??
        (target.brokerDeskFresh ? "brokerdesk_fresh_cache" : coreFreshness.status) ??
        "missing_route",
      readiness,
      strategyFamilies: target.strategyFamilies,
      canGeneratePaperIntent:
        route?.strategyModulePolicy?.canGeneratePaperIntent === true || brokerDeskPaperEligible,
      canUseForLiveOrder: false,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sourceBlocker: brokerDeskPaperEligible
        ? "BrokerDesk fresh cache matched resolved or paper-only static route; paper execution eligible only, live/write blocked."
        : route?.strategyModulePolicy?.blockedReason ||
          route?.reason ||
          evidence?.blockerCode ||
          coreProduct?.reason ||
          (target.brokerDeskFresh
            ? "BrokerDesk fresh cache 可供 paper exploration；尚未通過 resolved + fresh matched route，不可 live。"
            : "") ||
          "",
      liveEvidenceStatus: evidence?.status ?? "",
      ageSeconds: directA50Fresh
        ? directQuote.a50AgeSeconds
        : target.brokerDeskFresh
          ? target.brokerDeskAgeSeconds
          : coreFreshness.ageSeconds,
      quoteWallClockAgeSeconds: directA50Fresh
        ? directQuote.a50WallClockAgeSeconds
        : target.brokerDeskFresh
          ? target.brokerDeskAgeSeconds
          : coreFreshness.wallClockAgeSeconds,
      coreMatrixAgeSeconds: coreFreshness.matrixAgeSeconds,
      maxFreshSeconds: coreFreshness.maxFreshSeconds,
      quoteReceivedAt: target.brokerDeskFresh
        ? target.brokerDeskReceivedAt
        : coreFreshness.receivedAt,
      wallClockFresh: target.brokerDeskFresh ? true : targetWallClockFresh,
    };
  });
  const readyPaperTargetCount = activeUniverse.filter(
    (target) => target.canGeneratePaperIntent === true,
  ).length;
  const quoteFreshButRouteBlockedCount = activeUniverse.filter((target) =>
    ["quote_fresh_but_strategy_route_blocked", "core_quote_fresh_route_blocked"].includes(
      target.readiness,
    ),
  ).length;
  return {
    scope: "all_registered_capital_futures_routes",
    repoRoot,
    platformMode: "multi_product_target_registry",
    currentDirectTargetId: "a50-direct-request",
    routeSource: router
      ? "reports/hermes-agent/state/openclaw-capital-contract-month-router-latest.json"
      : "missing",
    coreMatrixSource: coreMatrix
      ? ".openclaw/quote/capital-core-product-freshness-matrix.json"
      : "missing",
    coverage: {
      routeCount: Number(router?.summary?.routeCount ?? routes.length),
      productSpecCount: Number(router?.summary?.productSpecCount ?? 0),
      registeredFuturesProductCount: Number(router?.summary?.registeredFuturesProductCount ?? 0),
      coveredRegistryProductCount: Number(router?.summary?.coveredRegistryProductCount ?? 0),
      uncoveredRegistryProducts: safeArray(router?.summary?.uncoveredRegistryProducts),
    },
    activeUniverse,
    summary: {
      activeUniverseCount: activeUniverse.length,
      readyPaperTargetCount,
      quoteFreshButRouteBlockedCount,
      blockedTargetCount: activeUniverse.length - readyPaperTargetCount,
      liveWritableTargetCount: 0,
      noLiveOrderSent: true,
      brokerDeskDynamicTargetCount: dynamicTargets.length,
      brokerDeskFreshCacheSymbolCount: Number(osSymbolCache?.symbolCount ?? 0),
      brokerDeskFreshCacheGeneratedAt: osSymbolCache?.generatedAt ?? "",
    },
    blockers:
      readyPaperTargetCount > 0 ? [] : ["target_registry:no_ready_current_paper_intent_targets"],
  };
}

function buildBlockers({
  status,
  directStatus,
  paperFill,
  paperOutcomeLedger,
  strategyFill,
  strategyTailRiskRepair,
  evaluator,
  targetRegistry,
  currentPaperIntents,
  quoteFreshness,
}) {
  const quote = directStatus.summary?.quote ?? {};
  const position = directStatus.summary?.position ?? {};
  const ack = directStatus.summary?.externalBrokerAdapter ?? {};
  const blockers = [
    ...safeArray(directStatus.summary?.blockers),
    ...safeArray(evaluator.blockers).map((item) => normalizeBlocker(item, "evaluator")),
    ...strategyRuleBlockers(evaluator),
    ...strategyFillGateBlockers(strategyFill),
    ...safeArray(targetRegistry?.blockers),
  ];
  if (currentPaperIntents?.status === "blocked_no_fresh_price_targets") {
    blockers.push("current_paper_intents:no_fresh_priced_targets");
  }
  if (currentPaperIntents?.status === "blocked_platform_report_missing") {
    blockers.push("current_paper_intents:platform_report_missing");
  }
  if (quoteFreshness?.strategyQuoteReady !== true) {
    blockers.push("quote:platform_no_fresh_strategy_target");
  }
  if (quote.a50Status !== "fresh") {
    blockers.push(`quote:a50_${quote.a50Status || "unknown"}`);
  }
  if (position.usable !== true) {
    blockers.push("position:verified_snapshot_missing");
  }
  if (ack.ackUsable !== true) {
    blockers.push("adapter:ack_missing");
  }
  if (paperFill.status !== "ok") {
    blockers.push(`paper_fill:${paperFill.status || "unknown"}`);
  }
  if (paperOutcomeLedger.status !== "ok") {
    blockers.push(`paper_outcome_ledger:${paperOutcomeLedger.status || "unknown"}`);
  }
  if (strategyFill.safetyLock?.executionEligible !== true) {
    blockers.push("strategy:execution_ineligible");
  }
  if (strategyFill.recommendation !== "promote") {
    blockers.push(`strategy_fill:${strategyFill.recommendation || "unknown"}`);
  }
  if (
    strategyTailRiskRepair.status !== "tail_risk_passed" &&
    safeArray(strategyFill?.promotionGate?.blockedReasons).includes("tail_risk_positive")
  ) {
    blockers.push(`tail_risk_repair:${strategyTailRiskRepair.status || "unknown"}`);
  }
  if (evaluator.recommendation !== "promote") {
    blockers.push(`strategy_evaluator:${evaluator.recommendation || "unknown"}`);
  }
  if (status === "blocked_live_promotion_required") {
    blockers.push("live:canary_rollback_promotion_gate_required");
  }
  return uniqueBlockers(blockers);
}

function liveStage(id, ok, evidence = {}, nextAction = "") {
  return {
    id,
    status: ok ? "pass" : "blocked",
    evidence,
    nextAction,
  };
}

function buildLiveCompletionMatrix({
  directStatus,
  operatorPacket,
  paperFill,
  strategyFill,
  evaluator,
  quoteFreshness,
}) {
  const quote = directStatus.summary?.quote ?? {};
  const position = directStatus.summary?.position ?? {};
  const adapterAck = operatorPacket.adapterAck ?? {};
  const directGateBlocked = directStatus.summary?.safety?.directGate === "blocked";
  const paperStrategyPromoted =
    paperFill.status === "ok" &&
    strategyFill.recommendation === "promote" &&
    evaluator.recommendation === "promote";
  const stages = [
    liveStage(
      "quote:strategy-ready",
      quoteFreshness.strategyQuoteReady === true,
      {
        overallFreshness: quoteFreshness.overallFreshness,
        a50Status: quote.a50Status ?? "",
        multiTargetFresh: quoteFreshness.multiTargetFresh === true,
        freshPaperTargetCount: quoteFreshness.freshPaperTargetCount,
      },
      "刷新 BrokerDesk/SKCOM quote state，重新產生 current paper intents 與 direct status。",
    ),
    liveStage(
      "position:verified-fresh",
      position.usable === true && position.freshnessStatus === "fresh",
      {
        decisionStatus: position.decisionStatus ?? "",
        freshnessStatus: position.freshnessStatus ?? "",
        verifiedAgeSeconds: position.verifiedAgeSeconds ?? null,
        maxFreshSeconds: position.maxFreshSeconds ?? null,
      },
      "由 operator 更新 verified position snapshot 後重跑 pnpm capital:trade:direct:status:check。",
    ),
    liveStage(
      "strategy:paper-promoted",
      paperStrategyPromoted,
      {
        paperFillStatus: paperFill.status ?? "",
        strategyFillRecommendation: strategyFill.recommendation ?? "",
        evaluatorRecommendation: evaluator.recommendation ?? "",
        promotionGateStatus: strategyFill.promotionGate?.status ?? "",
      },
      "先修 strategy fill/evaluator/tail-risk，再重跑 pnpm capital:trade:platform:check。",
    ),
    liveStage(
      "adapter:ack-hash-match",
      adapterAck.status === "verified" && adapterAck.hashOk === true,
      {
        status: adapterAck.status ?? "",
        hashOk: adapterAck.hashOk === true,
        expectedSealedIntentSha256: adapterAck.expectedSealedIntentSha256 ?? "",
        actualSealedIntentSha256: adapterAck.actualSealedIntentSha256 ?? "",
      },
      "由 operator-owned broker adapter 依 required-current template 更新 active ack。",
    ),
    liveStage(
      "adapter:canary-no-order",
      adapterAck.canaryPass === true && adapterAck.canarySentOrder === false,
      {
        canaryPass: adapterAck.canaryPass === true,
        canaryDryRun: adapterAck.canaryDryRun === true,
        canarySentOrder: adapterAck.canarySentOrder === true,
      },
      "adapter 只能先做 dry-run canary，確認 sentOrder=false。",
    ),
    liveStage(
      "adapter:rollback-fresh",
      adapterAck.rollbackPass === true && adapterAck.rollbackFresh === true,
      {
        rollbackPass: adapterAck.rollbackPass === true,
        rollbackFreshnessStatus: adapterAck.rollbackFreshnessStatus ?? "",
        rollbackAgeSeconds: adapterAck.rollbackAgeSeconds ?? null,
        rollbackMaxFreshSeconds: adapterAck.rollbackMaxFreshSeconds ?? null,
      },
      "重新驗證 rollback 並刷新 verifiedAt。",
    ),
    liveStage(
      "direct:pretrade-clear",
      directGateBlocked !== true && safeArray(directStatus.summary?.blockers).length === 0,
      {
        directGate: directStatus.summary?.safety?.directGate ?? "",
        blockers: safeArray(directStatus.summary?.blockers),
      },
      "清掉 direct pretrade/risk/live blockers；不得跳過風控。",
    ),
    liveStage(
      "operator-packet:execution-ready",
      operatorPacket.operatorCanExecute === true,
      {
        status: operatorPacket.status ?? "",
        operatorCanExecute: operatorPacket.operatorCanExecute === true,
        dispatchPolicy: operatorPacket.executionPayload?.dispatchPolicy ?? "",
      },
      "只有 operator packet ready 後，外部 operator-owned adapter 才能進入最後確認。",
    ),
  ];
  const blockers = stages
    .filter((stage) => stage.status !== "pass")
    .map((stage) => `live_completion:${stage.id}`);
  return {
    status: blockers.length === 0 ? "ready_for_external_operator_adapter_review" : "blocked",
    operatorCanExecute: operatorPacket.operatorCanExecute === true,
    dispatchPolicy: operatorPacket.executionPayload?.dispatchPolicy ?? "blocked_do_not_send",
    sealedOrderIntentSha256: operatorPacket.sealedIntentSha256 ?? "",
    passCount: stages.length - blockers.length,
    stageCount: stages.length,
    stages,
    blockers,
    noLiveOrderSent: true,
    sentOrder: false,
    writeBrokerOrders: false,
    nextAction:
      blockers.length > 0
        ? (stages.find((stage) => stage.status !== "pass")?.nextAction ?? "")
        : "外部 operator-owned adapter 可做最後人工確認；OpenClaw/Codex/Claude/Telegram 仍不直接送單。",
  };
}

function renderMarkdown(report) {
  const targetLines = report.strategyPlatform.targetRegistry.activeUniverse
    .map(
      (target) =>
        `- ${target.id}: ${target.readiness} / route=${target.routeStatus} / quote=${target.quoteReadiness}`,
    )
    .join("\n");
  return [
    "# Capital Direct Strategy Platform Gate",
    "",
    `generatedAt: ${report.generatedAt}`,
    `status: ${report.status}`,
    `requestedTrade: ${report.strategyPlatform.requestedTrade.instrument}`,
    `sealedOrderIntent: ${report.execution.sealedOrderIntentSha256}`,
    `activeUniverseCount: ${report.strategyPlatform.targetRegistry.summary.activeUniverseCount}`,
    "",
    "## Quote",
    "",
    `- Overall: ${report.quote.overallFreshness} / strategyQuoteReady=${report.quote.strategyQuoteReady}`,
    `- TX: ${report.quote.domestic.status} / ${report.quote.domestic.freshness}`,
    `- A50: ${report.quote.a50.status} / ageSeconds=${report.quote.a50.ageSeconds}`,
    `- Multi-target: ${report.quote.multiTarget.status} / freshPaperTargets=${report.quote.multiTarget.freshPaperTargetCount} / intents=${report.quote.multiTarget.generatedIntentCount}`,
    "",
    "## Target Registry",
    "",
    targetLines || "- none",
    "",
    "## Strategy",
    "",
    `- Paper fill: ${report.strategy.paperFill.status}`,
    `- Strategy fill: ${report.strategy.strategyFill.status} / ${report.strategy.strategyFill.recommendation}`,
    `- Strategy promotion gate: ${report.strategy.strategyFill.promotionGate?.status ?? "missing"} / ${report.strategy.strategyFill.promotionGate?.machineLine ?? "missing"}`,
    `- Evaluator: ${report.strategy.evaluator.status} / ${report.strategy.evaluator.recommendation}`,
    "",
    "## Execution",
    "",
    `- positionDecision: ${report.execution.positionDecision.status}`,
    `- adapterAck: ${report.externalBrokerAdapter.ack.status}`,
    `- noLiveOrderSent: ${report.safety.noLiveOrderSent}`,
    `- liveWriteAllowed: ${report.execution.liveWriteAllowed}`,
    "",
    "## Live Completion",
    "",
    `- status: ${report.liveCompletion.status}`,
    `- operatorCanExecute: ${report.liveCompletion.operatorCanExecute}`,
    `- dispatchPolicy: ${report.liveCompletion.dispatchPolicy}`,
    `- passCount: ${report.liveCompletion.passCount}/${report.liveCompletion.stageCount}`,
    ...report.liveCompletion.stages.map(
      (stage) => `- ${stage.id}: ${stage.status} / next=${stage.nextAction}`,
    ),
    "",
    "## Blockers",
    "",
    report.blockers.length ? report.blockers.map((item) => `- ${item}`).join("\n") : "- none",
    "",
  ].join("\n");
}

function buildBlockedOperatorPacketSnapshot({
  repoRoot,
  generatedAt,
  directStatus,
  directInputs,
  adapterAckGate,
}) {
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const sealedIntentSha256 = directStatus?.summary?.sealedOrderIntent?.sha256 ?? "";
  const directAck = directInputs?.activeTargets?.externalBrokerAdapterAck ?? {};
  const ackGate = adapterAckGate?.ack ?? {};
  const adapterAckStatus =
    directStatus?.summary?.externalBrokerAdapter?.ackStatus ??
    adapterAckGate?.status ??
    directAck.status ??
    "";
  const adapterHashOk = directAck.hashOk === true || ackGate.hashOk === true;
  const adapterCanarySentOrder = ackGate.canarySentOrder === true;
  const adapterRollbackFresh = ackGate.rollbackFresh === true;
  const blockers = [
    "readiness:not-ready",
    "direct:pretrade-not-ready",
    "platform:operator-packet-deferred",
  ];
  return {
    schema: "openclaw.capital.live-operator-execution-packet.v1",
    generatedAt,
    status: "blocked",
    mode: "platform_gate_cycle_safe_snapshot",
    sealedIntentSha256,
    operatorCanExecute: false,
    machineLine: [
      "capitalOperatorPacket=blocked",
      `sha256=${sealedIntentSha256 || "missing"}`,
      "readiness=deferred_to_platform_gate",
      `adapterAck=${adapterAckStatus || "missing"}`,
      `adapterHashOk=${adapterHashOk}`,
      `adapterCanarySentOrder=${adapterCanarySentOrder}`,
      `adapterRollbackFresh=${adapterRollbackFresh}`,
      "operatorCanExecute=false",
      "noOrderWrite=true",
      "sentOrder=false",
      `blockers=${blockers.length}`,
    ].join(" "),
    readiness: {
      status: "deferred_to_platform_gate",
      machineLine: "",
      blockers: ["platform-gate-cycle-safe-snapshot"],
    },
    adapterAck: {
      status: adapterAckStatus,
      machineLine: adapterAckGate?.machineLine ?? "",
      hashOk: adapterHashOk,
      canaryPass: ackGate.canaryPass === true,
      canaryDryRun: ackGate.canaryDryRun === true,
      canarySentOrder: adapterCanarySentOrder,
      rollbackPass: ackGate.rollbackPass === true,
      rollbackVerifiedAt: ackGate.rollbackVerifiedAt ?? "",
      rollbackAgeSeconds: ackGate.rollbackAgeSeconds ?? null,
      rollbackMaxFreshSeconds: ackGate.rollbackMaxFreshSeconds ?? null,
      rollbackFresh: adapterRollbackFresh,
      rollbackFreshnessStatus: ackGate.rollbackFreshnessStatus ?? "unknown",
      expectedSealedIntentSha256:
        directAck.expectedSealedIntentSha256 ??
        ackGate.expectedValue?.sealedIntentSha256 ??
        sealedIntentSha256,
      actualSealedIntentSha256: directAck.actualSealedIntentSha256 ?? "",
      requiredTemplatePath: ackGate.requiredTemplatePath ?? "",
    },
    executionPayload: {
      destination: "external_operator_owned_broker_adapter",
      brokerApi: "",
      brokerStruct: "",
      sealedOrderIntent: {},
      commandPayload: {},
      brokerFields: {},
      stops: {},
      dispatchPolicy: "blocked_do_not_send",
    },
    blockers,
    safety: {
      generatedPacketOnly: true,
      wroteBrokerCommand: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
      liveTradingEnabled: false,
      codexBrokerWriteAllowed: false,
      claudeBrokerWriteAllowed: false,
      openclawBrokerWriteAllowed: false,
      telegramBrokerWriteAllowed: false,
      requiresExternalOperatorOwnedAdapter: true,
      containsCredentials: false,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
    },
    paths: {
      reportPath: path.join(
        stateRoot,
        "openclaw-capital-live-operator-execution-packet-latest.json",
      ),
      markdownPath: path.join(
        stateRoot,
        "openclaw-capital-live-operator-execution-packet-latest.md",
      ),
      packetPath: path.join(tradingRoot, "capital-live-operator-execution-packet.json"),
    },
  };
}

export async function buildCapitalDirectStrategyPlatformGate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const generatedAt = new Date().toISOString();
  const [directStatus, directInputs] = await Promise.all([
    buildCapitalDirectOperationStatus({ repoRoot }),
    buildCapitalDirectOperationInputs({ repoRoot }),
  ]);
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-direct-strategy-platform-gate-latest.json",
  );
  const markdownPath = path.join(
    stateRoot,
    "openclaw-capital-direct-strategy-platform-gate-latest.md",
  );
  const panelPath = path.join(tradingRoot, "capital-direct-strategy-platform-gate.json");
  const currentPaperIntentsPath = path.join(
    stateRoot,
    "openclaw-capital-current-paper-intents-from-target-registry-latest.json",
  );
  const adapterAckGatePath = path.join(
    stateRoot,
    "openclaw-capital-external-broker-adapter-ack-gate-latest.json",
  );
  const adapterAckGate = await readJsonIfExists(adapterAckGatePath);
  const operatorPacket = buildBlockedOperatorPacketSnapshot({
    repoRoot,
    generatedAt,
    directStatus,
    directInputs,
    adapterAckGate,
  });
  const brokerDeskStateDir = resolveCapitalHftStateDir();
  const [router, coreMatrix, osSymbolCache] = await Promise.all([
    readJsonIfExists(
      path.join(stateRoot, "openclaw-capital-contract-month-router-latest.json"),
    ).then(
      (value) =>
        value ??
        readJsonIfExists(
          path.join(repoRoot, ".openclaw", "quote", "capital-contract-month-router.json"),
        ),
    ),
    readJsonIfExists(
      path.join(repoRoot, ".openclaw", "quote", "capital-core-product-freshness-matrix.json"),
    ),
    readJsonIfExists(path.join(brokerDeskStateDir, "os_symbol_cache.json")),
  ]);
  const nowMs = Date.parse(generatedAt);
  const quote = directStatus.summary.quote;
  const requestedTrade = directStatus.summary.requestedTrade;
  const targetRegistry = buildTargetRegistry({
    repoRoot,
    router,
    coreMatrix,
    directStatus,
    osSymbolCache,
    nowMs,
  });
  const currentPaperIntentsResult = await buildCapitalCurrentPaperIntentsFromTargetRegistry({
    repoRoot,
    platformReport: {
      schema: SCHEMA,
      generatedAt,
      repoRoot,
      status: "current_cycle_pre_strategy",
      strategyPlatform: { targetRegistry },
    },
  });
  const currentPaperIntents = await writeCapitalCurrentPaperIntentsState(currentPaperIntentsResult);
  const paperOutcomeLedger = await runCapitalPaperOutcomeLedger({ repoRoot });
  const paperFill = await runCapitalPaperFillSimulation({ repoRoot });
  const strategyFill = await runStrategyFillSimulation({ repoRoot });
  const strategyTailRiskRepair = await writeCapitalStrategyTailRiskRepairPlan({
    repoRoot,
    strategyFill,
  });
  const evaluator = await runCapitalPaperStrategyEvaluator({ repoRoot });
  const quoteFreshness = buildPlatformQuoteFreshnessSummary({
    directStatus,
    targetRegistry,
    currentPaperIntents,
  });
  const status = computeStatus({
    directStatus,
    paperFill,
    strategyFill,
    evaluator,
    quoteFreshness,
  });
  const liveCompletion = buildLiveCompletionMatrix({
    directStatus,
    operatorPacket,
    paperFill,
    strategyFill,
    evaluator,
    quoteFreshness,
  });
  const blockers = uniqueBlockers(
    buildBlockers({
      status,
      directStatus,
      paperFill,
      paperOutcomeLedger,
      strategyFill,
      strategyTailRiskRepair,
      evaluator,
      targetRegistry,
      currentPaperIntents,
      quoteFreshness,
    }),
    liveCompletion.blockers,
  );
  const report = {
    schema: SCHEMA,
    generatedAt,
    repoRoot,
    status,
    strategyPlatform: {
      mode: "paper_strategy_plus_sealed_intent_gate",
      requestedTrade,
      currentDirectTrade: requestedTrade,
      targetRegistry,
      loop: [
        "quote_status",
        "strategy_signal",
        "paper_fill_simulation",
        "paper_outcome_ledger",
        "strategy_tail_risk_repair",
        "paper_strategy_evaluation",
        "risk_handoff_gate",
        "operator_owned_broker_adapter_ack",
      ],
      directEntryPoints: {
        openclaw: "pnpm capital:trade:platform",
        check: "pnpm capital:trade:platform:check",
        directStatus: directStatus.summary.directEntryPoints.openclaw,
        telegram: "sc:tr:direct",
      },
      aiDecisionBoundary:
        "AI may rank and explain paper strategy decisions, but cannot bypass quote, position, adapter ack, canary, rollback, or promotion gates.",
    },
    quote: {
      overallFreshness: quoteFreshness.overallFreshness,
      strategyQuoteReady: quoteFreshness.strategyQuoteReady,
      serviceStatus: quote.serviceStatus,
      domestic: {
        status: quote.domesticTxStatus,
        session: quote.domesticTxSession,
        freshness: quote.domesticTxFreshness,
        stockNo: quote.domesticTxStockNo,
        receivedAt: quote.domesticTxReceivedAt,
      },
      a50: {
        status: quote.a50Status,
        subscribed: quote.a50Subscribed,
        ageSeconds: quote.a50AgeSeconds,
        unblockCondition: quote.a50UnblockCondition,
      },
      multiTarget: {
        status: quoteFreshness.multiTargetFresh ? "fresh" : "blocked",
        currentPaperIntentsFresh: quoteFreshness.currentPaperIntentsFresh,
        generatedIntentCount: quoteFreshness.generatedIntentCount,
        freshPaperTargetCount: quoteFreshness.freshPaperTargetCount,
        freshPaperSymbols: quoteFreshness.freshPaperSymbols,
        freshPaperTargetIds: quoteFreshness.freshPaperTargetIds,
        brokerDeskDynamicTargetCount: quoteFreshness.brokerDeskDynamicTargetCount,
        noLiveOrderSent: quoteFreshness.noLiveOrderSent,
      },
    },
    strategy: {
      paperFill: {
        schema: paperFill.schema,
        status: paperFill.status,
        stats: paperFill.stats ?? {},
        monteCarlo: paperFill.monteCarlo ?? {},
        safetyLock: paperFill.safetyLock ?? {},
      },
      paperOutcomeLedger: {
        schema: paperOutcomeLedger.schema,
        status: paperOutcomeLedger.status,
        stats: paperOutcomeLedger.stats ?? {},
        safetyLock: paperOutcomeLedger.safetyLock ?? {},
        learningRegistryUpdated: paperOutcomeLedger.learningRegistryUpdated === true,
      },
      strategyFill: {
        schema: strategyFill.schema,
        status: strategyFill.status,
        recommendation: strategyFill.recommendation,
        source: strategyFill.source ?? {},
        stats: strategyFill.stats ?? {},
        monteCarlo: strategyFill.monteCarlo ?? {},
        promotionGate: strategyFill.promotionGate ?? {},
        tailRiskRepair: strategyFill.tailRiskRepair ?? {},
        safetyLock: strategyFill.safetyLock ?? {},
      },
      strategyTailRiskRepair: {
        schema: strategyTailRiskRepair.schema,
        status: strategyTailRiskRepair.status,
        selectedSymbols: strategyTailRiskRepair.selectedSymbols ?? [],
        repairActions: strategyTailRiskRepair.repairActions ?? [],
        repairCandidatePlan: strategyTailRiskRepair.repairCandidatePlan ?? {},
        safetyLock: strategyTailRiskRepair.safetyLock ?? {},
        machineLine: strategyTailRiskRepair.machineLine ?? "",
      },
      evaluator: {
        schema: evaluator.schema,
        status: evaluator.status,
        recommendation: evaluator.recommendation,
        passCount: evaluator.passCount,
        ruleCount: evaluator.ruleCount,
        failedRules: evaluator.failedRules ?? [],
        blockers: evaluator.blockers ?? [],
        safetyLock: evaluator.safetyLock ?? {},
      },
      currentPaperIntents: {
        schema: currentPaperIntents?.schema ?? "",
        status: currentPaperIntents?.status ?? "missing",
        activeIntentsRecordCount: currentPaperIntents?.intentWrite?.activeIntentsRecordCount ?? 0,
        generatedIntentCount: currentPaperIntents?.targetRegistry?.generatedIntentCount ?? 0,
        candidateTargetCount: currentPaperIntents?.targetRegistry?.candidateTargetCount ?? 0,
        writtenTargetIds: currentPaperIntents?.targetRegistry?.writtenTargetIds ?? [],
        safetyLock: currentPaperIntents?.safety ?? {},
      },
    },
    positionDecision: directStatus.summary.position,
    externalBrokerAdapter: {
      required: directStatus.summary.externalBrokerAdapter.required,
      ack: {
        status: directStatus.summary.externalBrokerAdapter.ackStatus,
        usable: directStatus.summary.externalBrokerAdapter.ackUsable,
        path: directStatus.summary.externalBrokerAdapter.ackPath,
        requiredSealedIntentSha256:
          directStatus.summary.externalBrokerAdapter.requiredSealedIntentSha256,
      },
      currentLivePolicy: directStatus.summary.externalBrokerAdapter.currentLivePolicy,
    },
    execution: {
      mode: "paper_or_sealed_intent_only",
      liveWriteAllowed: false,
      sentOrder: false,
      noLiveOrderSent: true,
      sealedOrderIntentSha256: directStatus.summary.sealedOrderIntent.sha256,
      sealedOrderIntentStatus: directStatus.summary.sealedOrderIntent.status,
      positionDecision: {
        status: directStatus.summary.position.decisionStatus,
        conclusion: directStatus.summary.position.decisionConclusion,
      },
      externalBrokerAdapterAckStatus: directStatus.summary.externalBrokerAdapter.ackStatus,
      operatorCanExecute: operatorPacket.operatorCanExecute === true,
      operatorPacketStatus: operatorPacket.status ?? "",
      dispatchPolicy: operatorPacket.executionPayload?.dispatchPolicy ?? "",
      activeTargets: directInputs.activeTargets,
    },
    liveCompletion,
    safety: {
      paperOnly: true,
      noLiveOrderSent: true,
      no_live_order_sent: true,
      sentOrder: false,
      writeBrokerOrders: false,
      writeTradingEnabled: false,
      brokerWriteAttempted: false,
      liveTradingEnabled: false,
      codexBrokerWriteAllowed: false,
      claudeBrokerWriteAllowed: false,
      openclawBrokerWriteAllowed: false,
      telegramBrokerWriteAllowed: false,
      generatedTemplatesOnly: true,
    },
    blockers,
    sourceReports: {
      directStatus: directStatus.paths.reportPath,
      directInputs: directInputs.paths.reportPath,
      operatorPacket: operatorPacket.paths?.reportPath ?? "",
      targetRegistry: targetRegistry.routeSource,
      coreProductMatrix: targetRegistry.coreMatrixSource,
      paperFill: path.join(tradingRoot, "capital-paper-fill-simulation.json"),
      paperOutcomeLedger: path.join(tradingRoot, "capital-paper-outcome-ledger-latest.json"),
      strategyTailRiskRepair:
        strategyTailRiskRepair.paths?.reportPath ??
        path.join(stateRoot, "openclaw-capital-strategy-tail-risk-repair-latest.json"),
      strategyFill: path.join(tradingRoot, "capital-strategy-fill-simulation.json"),
      evaluator: path.join(tradingRoot, "capital-paper-strategy-evaluation.json"),
      currentPaperIntents: currentPaperIntentsPath,
    },
    paths: {
      reportPath,
      markdownPath,
      panelPath,
    },
    nextSafeTask:
      currentPaperIntents?.status === "blocked_no_fresh_price_targets"
        ? "刷新 BrokerDesk/SKCOM quote state 後重跑 pnpm capital:trade:current-paper-intents:check；仍維持 noLiveOrderSent=true。"
        : (strategyTailRiskRepair.nextSafeTask ??
          strategyFill.promotionGate?.nextSafeTask ??
          "重跑 paper fill/evaluator/platform gate；若 promotion 未通過仍不得送真單。"),
  };
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapitalDirectStrategyPlatformGate({ repoRoot: process.cwd() });
  if (options.writeState || options.check) {
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
    await writeTextWithSha(report.paths.markdownPath, renderMarkdown(report));
  }
  if (options.check) {
    if (!ALLOWED_STATUSES.has(report.status)) {
      throw new Error(`CAPITAL_DIRECT_STRATEGY_PLATFORM_STATUS_INVALID=${report.status}`);
    }
    if (
      report.safety.noLiveOrderSent !== true ||
      report.safety.sentOrder !== false ||
      report.execution.liveWriteAllowed !== false ||
      report.safety.writeBrokerOrders !== false
    ) {
      throw new Error("CAPITAL_DIRECT_STRATEGY_PLATFORM_SAFETY_MISMATCH");
    }
  }
  if (options.json || options.check) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `CAPITAL_DIRECT_STRATEGY_PLATFORM=${report.status} sha256=${report.execution.sealedOrderIntentSha256} position=${report.execution.positionDecision.status} ack=${report.externalBrokerAdapter.ack.status} quote=${report.quote.overallFreshness} noLiveOrderSent=${report.safety.noLiveOrderSent}\n`,
    );
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
