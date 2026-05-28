import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCapitalContractMonthRouter } from "./openclaw-capital-contract-month-router.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-contract-router-"));
const reportableStatePath = path.join(tempRoot, "capital-reportable-quote-state.json");
const capitalOsProductListPath = path.join(tempRoot, "hft_os_product_list.json");
await fs.writeFile(
  reportableStatePath,
  `${JSON.stringify(
    {
      schema: "openclaw.capital.reportable-quote-state.v1",
      status: "partial_ready",
      reportableQuotes: [
        {
          query: "TX00AM",
          symbol: "TX00AM",
          source: "domestic",
          close: 41632,
          bid: 41632,
          ask: 41637,
          receivedAt: "2026-05-21T12:23:12.9749817+08:00",
          sourceFile: "capital_quote_events.jsonl",
        },
        {
          query: "CL0000",
          symbol: "CL0000",
          source: "overseas",
          close: 99.18,
          bid: 99.16,
          ask: 99.18,
          receivedAt: "2026-05-21T12:23:04.7895688+08:00",
          sourceFile: "os_symbol_cache.json",
        },
        {
          query: "TX06AM",
          symbol: "TX06AM",
          source: "domestic",
          close: 41700,
          bid: 41699,
          ask: 41701,
          receivedAt: "2026-05-21T12:23:13.1749817+08:00",
          sourceFile: "capital_quote_events.jsonl",
        },
        {
          query: "TX07AM",
          symbol: "TX07AM",
          source: "domestic",
          close: 41750,
          bid: 41749,
          ask: 41751,
          receivedAt: "2026-05-21T12:23:14.1749817+08:00",
          sourceFile: "capital_quote_events.jsonl",
        },
      ],
      blockedQuotes: [],
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await fs.writeFile(
  capitalOsProductListPath,
  `${JSON.stringify(
    {
      schema: "openclaw.capital.os-product-list.v1",
      generatedAt: "2026-05-25T00:17:43.3283482+08:00",
      count: 15,
      products: [
        "NYM,紐約商業交易所,CL0000,輕原油熱2607,20260622,20260624",
        "NYM,紐約商業交易所,CL2607,紐約輕原油2607,20260622,20260624",
        "NYM,紐約商業交易所,CL2608,紐約輕原油2608,20260721,20260723",
        "NYM,紐約商業交易所,QM0000,小輕原油熱2607,20260618,20260618",
        "NYM,紐約商業交易所,QM2607,紐約小輕原油2607,20260618,20260618",
        "NYM,紐約商業交易所,QM2608,紐約小輕原油2608,20260720,20260720",
        "NYM,紐約商業交易所,MCL0000,微輕原油熱2607,20260618,20260618",
        "NYM,紐約商業交易所,MCL2607,紐約微型輕原油2607,20260618,20260618",
        "NYM,紐約商業交易所,MCL2608,紐約微型輕原油2608,20260720,20260720",
        "NYM,紐約商業交易所,BZ0000,布蘭特油熱2607,20260529,20260529",
        "NYM,紐約商業交易所,BZ2607,紐約布蘭特油2607,20260529,20260529",
        "NYM,紐約商業交易所,BZ2608,紐約布蘭特油2608,20260630,20260630",
        "NYM,紐約商業交易所,NG0000,天然氣熱2606,20260527,20260528",
        "NYM,紐約商業交易所,NG2606,紐約天然氣2606,20260527,20260528",
        "NYM,紐約商業交易所,NG2607,紐約天然氣2607,20260626,20260629",
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const payload = await buildCapitalContractMonthRouter({
  now: "2026-05-21T04:23:17.841Z",
  reportableState: reportableStatePath,
  capitalOsProductList: capitalOsProductListPath,
});

if (payload.schema !== "openclaw.capital.contract-month-router.v1") {
  throw new Error(`unexpected schema: ${payload.schema}`);
}
if (
  !payload.readOnly ||
  payload.loginAttempted ||
  payload.liveTradingEnabled ||
  payload.writeTradingEnabled ||
  payload.sentOrder
) {
  throw new Error("router must stay read-only and no-login/no-trade");
}
if (payload.summary.registeredFuturesProductCount < 60) {
  throw new Error(
    `router must cover the full registered futures universe, got ${payload.summary.registeredFuturesProductCount}`,
  );
}
if (
  payload.summary.coveredRegistryProductCount !== payload.summary.registeredFuturesProductCount ||
  payload.summary.uncoveredRegistryProducts.length !== 0
) {
  throw new Error(
    `all registered futures products must be mapped into router specs: ${JSON.stringify(payload.summary)}`,
  );
}
if (payload.strategyModuleContract?.liveTradingEnabled !== false) {
  throw new Error(
    `strategy module contract must stay paper-only: ${JSON.stringify(payload.strategyModuleContract)}`,
  );
}

const txCurrent = payload.routes.find(
  (route) => route.marketCode === "TXF" && route.routingMode === "current-month",
);
if (!txCurrent) {
  throw new Error("missing TXF current-month route");
}
if (
  !txCurrent.selectedSymbols.includes("TX06AM") ||
  !txCurrent.selectedSymbols.includes("TX06PM")
) {
  throw new Error(
    `TXF current-month must include TX06 session aliases after May expiry rollover: ${JSON.stringify(txCurrent)}`,
  );
}
if (txCurrent.selectedSymbols.includes("TX00AM") || txCurrent.selectedSymbols.includes("TX00")) {
  throw new Error(
    `TXF current-month must not include TX00 front aliases: ${JSON.stringify(txCurrent)}`,
  );
}
if (txCurrent.quoteReadiness !== "fresh_matched") {
  throw new Error(
    `TXF current-month should be fresh by TX06AM evidence after rollover: ${JSON.stringify(txCurrent)}`,
  );
}
if (
  txCurrent.rolloverPolicy?.basis !== "taifex_third_wednesday" ||
  txCurrent.rolloverPolicy?.targetCalendarMonth !== "202606" ||
  txCurrent.strategyModulePolicy?.canGeneratePaperIntent !== true
) {
  throw new Error(
    `TXF current-month must expose rollover + strategy module policy: ${JSON.stringify(txCurrent)}`,
  );
}
if (txCurrent.selectedSymbols.some((symbol) => /^TX05(?:AM|PM)?$/u.test(symbol))) {
  throw new Error(
    `TXF current-month must not include expired TX05 symbols: ${JSON.stringify(txCurrent.selectedSymbols)}`,
  );
}

const txFront = payload.routes.find(
  (route) => route.marketCode === "TXF" && route.routingMode === "front-month",
);
if (
  !txFront ||
  !txFront.selectedSymbols.includes("TX00AM") ||
  txFront.selectedSymbols.includes("TX05AM")
) {
  throw new Error(`TXF front-month must stay on TX00 aliases only: ${JSON.stringify(txFront)}`);
}
if (txFront.quoteReadiness !== "fresh_matched") {
  throw new Error(`TXF front-month should be fresh by TX00AM evidence: ${JSON.stringify(txFront)}`);
}

const txNext = payload.routes.find(
  (route) => route.marketCode === "TXF" && route.routingMode === "next-month",
);
if (!txNext) {
  throw new Error("missing TXF next-month route");
}
if (!txNext.selectedSymbols.includes("TX07AM") || !txNext.selectedSymbols.includes("TX07PM")) {
  throw new Error(
    `TXF next-month must include TX07 session aliases after TX06 current route: ${JSON.stringify(txNext)}`,
  );
}
if (txNext.selectedSymbols.includes("TX06AM") || txNext.selectedSymbols.includes("TX00AM")) {
  throw new Error(
    `TXF next-month must not fall back to current/front aliases: ${JSON.stringify(txNext)}`,
  );
}
if (txNext.quoteReadiness !== "fresh_matched") {
  throw new Error(`TXF next-month should be fresh by TX07AM evidence: ${JSON.stringify(txNext)}`);
}
if (
  txNext.rolloverPolicy?.targetCalendarMonth !== "202607" ||
  txNext.strategyModulePolicy?.canGeneratePaperIntent !== true
) {
  throw new Error(
    `TXF next-month must expose strategy-safe roll policy: ${JSON.stringify(txNext)}`,
  );
}

const clCurrent = payload.routes.find(
  (route) => route.marketCode === "CL" && route.routingMode === "current-month",
);
if (!clCurrent) {
  throw new Error("missing CL current-month route");
}
if (
  !clCurrent.selectedSymbols.includes("NYM,CL2607") ||
  !clCurrent.selectedSymbols.includes("CL2607") ||
  clCurrent.targetCalendarMonth !== "202607" ||
  clCurrent.capitalProductListEvidence?.selectedContract?.code !== "CL2607"
) {
  throw new Error(
    `CL current-month must use Capital-listed NYM,CL2607 / CL2607 candidates: ${JSON.stringify(clCurrent)}`,
  );
}
if (
  !clCurrent.invalidFormats.includes("CL_202607") ||
  !clCurrent.invalidFormats.includes("CL202607")
) {
  throw new Error(
    `CL invalid formats must document CL_202607 / CL202607: ${JSON.stringify(clCurrent.invalidFormats)}`,
  );
}
if (clCurrent.quoteReadiness !== "needs_subscription_callback") {
  throw new Error(
    `CL current-month should require explicit subscription callback: ${JSON.stringify(clCurrent)}`,
  );
}

const clHot = payload.routes.find(
  (route) => route.marketCode === "CL" && route.routingMode === "hot-month",
);
if (
  !clHot ||
  !clHot.selectedSymbols.includes("CL0000") ||
  clHot.quoteReadiness !== "fresh_matched"
) {
  throw new Error(`CL hot-month should remain CL0000 fresh evidence: ${JSON.stringify(clHot)}`);
}

const clNext = payload.routes.find(
  (route) => route.marketCode === "CL" && route.routingMode === "next-month",
);
if (
  !clNext ||
  !clNext.selectedSymbols.includes("NYM,CL2608") ||
  !clNext.selectedSymbols.includes("CL2608") ||
  clNext.targetCalendarMonth !== "202608" ||
  clNext.capitalProductListEvidence?.selectedContract?.code !== "CL2608"
) {
  throw new Error(
    `CL next-month must use Capital-listed NYM,CL2608 / CL2608 candidates: ${JSON.stringify(clNext)}`,
  );
}

const ngCurrent = payload.routes.find(
  (route) => route.marketCode === "NG" && route.routingMode === "current-month",
);
if (
  !ngCurrent ||
  ngCurrent.routeStatus !== "resolved" ||
  !ngCurrent.selectedSymbols.includes("NG2606") ||
  ngCurrent.targetCalendarMonth !== "202606" ||
  ngCurrent.capitalProductListEvidence?.selectedContract?.code !== "NG2606" ||
  ngCurrent.rolloverPolicy?.policyStatus !== "configured" ||
  !ngCurrent.officialCatalogEvidence?.terminationRule
) {
  throw new Error(
    `NG current-month must be official-catalog resolved with rollover evidence: ${JSON.stringify(ngCurrent)}`,
  );
}
if (ngCurrent.strategyModulePolicy?.canGeneratePaperIntent !== false) {
  throw new Error(
    `NG current-month must remain strategy-blocked until fresh matched callback: ${JSON.stringify(ngCurrent)}`,
  );
}

const mclNext = payload.routes.find(
  (route) => route.marketCode === "MCL" && route.routingMode === "next-month",
);
if (
  !mclNext ||
  mclNext.routeStatus !== "resolved" ||
  !mclNext.selectedSymbols.includes("MCL2608") ||
  mclNext.targetCalendarMonth !== "202608" ||
  mclNext.capitalProductListEvidence?.selectedContract?.code !== "MCL2608" ||
  mclNext.rolloverPolicy?.policyStatus !== "configured" ||
  !mclNext.officialCatalogEvidence?.sourceId
) {
  throw new Error(
    `MCL next-month must be official-catalog resolved with rollover evidence: ${JSON.stringify(mclNext)}`,
  );
}

const nqCurrent = payload.routes.find(
  (route) => route.marketCode === "NQ" && route.routingMode === "current-month",
);
if (!nqCurrent || nqCurrent.routeStatus !== "blocked") {
  throw new Error(
    `NQ current-month May 2026 must be blocked by quarterly cycle: ${JSON.stringify(nqCurrent)}`,
  );
}
if (nqCurrent.blockerCode !== "current_month_not_listed_by_quarterly_cycle") {
  throw new Error(`unexpected NQ blocker: ${JSON.stringify(nqCurrent)}`);
}
if (
  !nqCurrent.invalidFormats.includes("CME,NQ_202605") ||
  !nqCurrent.invalidFormats.includes("NQ202605")
) {
  throw new Error(
    `NQ invalid formats should document rejected YYYYMM forms: ${JSON.stringify(nqCurrent.invalidFormats)}`,
  );
}

const nqNext = payload.routes.find(
  (route) => route.marketCode === "NQ" && route.routingMode === "next-month",
);
if (!nqNext || nqNext.routeStatus !== "resolved") {
  throw new Error(
    `NQ next-month June 2026 must be a listed quarter-month route: ${JSON.stringify(nqNext)}`,
  );
}
if (!nqNext.selectedSymbols.includes("CME,NQ2606") || !nqNext.selectedSymbols.includes("NQ2606")) {
  throw new Error(`NQ next-month must use 2606 quarter candidates: ${JSON.stringify(nqNext)}`);
}

const a50Current = payload.routes.find(
  (route) => route.marketCode === "A50" && route.routingMode === "current-month",
);
if (!a50Current || a50Current.routeStatus !== "requires_catalog_verification") {
  throw new Error(
    `A50 current-month must require catalog verification: ${JSON.stringify(a50Current)}`,
  );
}

const a50Next = payload.routes.find(
  (route) => route.marketCode === "A50" && route.routingMode === "next-month",
);
if (!a50Next || a50Next.routeStatus !== "requires_catalog_verification") {
  throw new Error(`A50 next-month must require catalog verification: ${JSON.stringify(a50Next)}`);
}
const allRegisteredFrontRoutes = payload.routes.filter(
  (route) => route.registryProductIds?.length > 0 && route.routingMode === "front-month",
);
if (allRegisteredFrontRoutes.length < 50) {
  throw new Error(
    `expected broad registered futures front routes, got ${allRegisteredFrontRoutes.length}`,
  );
}
const gcCurrent = payload.routes.find(
  (route) => route.marketCode === "GC" && route.routingMode === "current-month",
);
if (!gcCurrent || !gcCurrent.selectedSymbols.includes("GC2605")) {
  throw new Error(`GC current-month candidate route missing: ${JSON.stringify(gcCurrent)}`);
}
if (gcCurrent.routeStatus !== "requires_catalog_verification") {
  throw new Error(
    `GC current-month must stay catalog-gated until official callback: ${JSON.stringify(gcCurrent)}`,
  );
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      checkedRoutes: payload.summary.routeCount,
      registeredFuturesProductCount: payload.summary.registeredFuturesProductCount,
      assertions: [
        "All registered futures products are covered by contract-month router specs",
        "Every route exposes rolloverPolicy and strategyModulePolicy",
        "TXF current-month rolls past expired TX05* to TX06*",
        "TXF next-month advances from TX06* to TX07*",
        "TXF front/hot stays TX00*",
        "CL current-month uses Capital-listed CLYYMM and rejects CL_YYYYMM",
        "CL next-month uses Capital-listed CLYYMM for 2608",
        "NG current-month uses Capital-listed official energy catalog rollover evidence",
        "MCL next-month uses Capital-listed official energy catalog rollover evidence",
        "NQ current-month blocks non-quarterly month",
        "NQ next-month resolves June quarter month",
        "A50 current-month requires official catalog verification",
        "A50 next-month requires official catalog verification",
      ],
    },
    null,
    2,
  ),
);
