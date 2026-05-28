import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCapitalContractCatalogVerification } from "./openclaw-capital-contract-catalog-verification.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-catalog-check-"));
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

const payload = await buildCapitalContractCatalogVerification({
  now: "2026-05-21T04:23:17.841Z",
  reportableState: reportableStatePath,
  capitalOsProductList: capitalOsProductListPath,
});

if (payload.schema !== "openclaw.capital.contract-catalog-verification.v1") {
  throw new Error(`unexpected schema: ${payload.schema}`);
}
if (
  !payload.readOnly ||
  payload.loginAttempted ||
  payload.liveTradingEnabled ||
  payload.writeTradingEnabled ||
  payload.sentOrder
) {
  throw new Error("catalog verification must stay read-only and no-login/no-trade");
}
if (payload.summary.registeredFuturesProductCount < 60) {
  throw new Error(
    `expected full futures universe coverage, got ${payload.summary.registeredFuturesProductCount}`,
  );
}
if (
  payload.summary.coveredRegistryProductCount !== payload.summary.registeredFuturesProductCount ||
  payload.summary.uncoveredRegistryProducts.length !== 0
) {
  throw new Error(`uncovered registry products: ${JSON.stringify(payload.summary)}`);
}

const txCurrent = payload.rows.find(
  (row) => row.marketCode === "TXF" && row.routingMode === "current-month",
);
if (
  !txCurrent ||
  txCurrent.catalogStatus !== "callback_verified" ||
  txCurrent.strategyEligiblePaper !== true ||
  !txCurrent.selectedSymbols.includes("TX06AM")
) {
  throw new Error(
    `TXF current-month must be callback verified in fixture: ${JSON.stringify(txCurrent)}`,
  );
}

const txNext = payload.rows.find(
  (row) => row.marketCode === "TXF" && row.routingMode === "next-month",
);
if (
  !txNext ||
  txNext.catalogStatus !== "callback_verified" ||
  txNext.strategyEligiblePaper !== true ||
  !txNext.selectedSymbols.includes("TX07AM") ||
  txNext.selectedSymbols.includes("TX06AM") ||
  txNext.selectedSymbols.includes("TX00AM")
) {
  throw new Error(`TXF next-month must verify TX07 only: ${JSON.stringify(txNext)}`);
}

const gcCurrent = payload.rows.find(
  (row) => row.marketCode === "GC" && row.routingMode === "current-month",
);
if (
  !gcCurrent ||
  gcCurrent.catalogStatus !== "requires_official_catalog" ||
  gcCurrent.strategyEligiblePaper !== false ||
  !gcCurrent.selectedSymbols.includes("GC2605")
) {
  throw new Error(
    `GC current-month must remain official-catalog gated: ${JSON.stringify(gcCurrent)}`,
  );
}

const expectedEnergyCurrentSymbols = new Map([
  ["CL", "CL2607"],
  ["QM", "QM2607"],
  ["MCL", "MCL2607"],
  ["BZ", "BZ2607"],
  ["NG", "NG2606"],
]);
for (const [marketCode, expectedSymbol] of expectedEnergyCurrentSymbols.entries()) {
  const route = payload.rows.find(
    (row) => row.marketCode === marketCode && row.routingMode === "current-month",
  );
  if (!route) {
    throw new Error(`missing energy current-month route for ${marketCode}`);
  }
  if (
    route.catalogStatus === "requires_official_catalog" ||
    route.catalogStatus !== "requires_subscription_callback" ||
    route.strategyEligiblePaper !== false ||
    route.autoRollAllowed !== true ||
    route.rolloverPolicyStatus !== "configured" ||
    !route.selectedSymbols.includes(expectedSymbol) ||
    route.capitalProductListSelectedContractCode !== expectedSymbol ||
    !route.officialCatalogSourceId ||
    !route.officialCatalogSourceUrl ||
    !route.terminationRule
  ) {
    throw new Error(
      `energy ${marketCode} must be official-catalog resolved but callback-gated: ${JSON.stringify(route)}`,
    );
  }
}

const nqCurrent = payload.rows.find(
  (row) => row.marketCode === "NQ" && row.routingMode === "current-month",
);
if (!nqCurrent || nqCurrent.catalogStatus !== "blocked_by_contract_cycle") {
  throw new Error(
    `NQ current-month May route must be blocked by contract cycle: ${JSON.stringify(nqCurrent)}`,
  );
}

const nqNext = payload.rows.find(
  (row) => row.marketCode === "NQ" && row.routingMode === "next-month",
);
if (!nqNext || !nqNext.selectedSymbols.includes("CME,NQ2606")) {
  throw new Error(`NQ next-month must expose June quarter candidate: ${JSON.stringify(nqNext)}`);
}

const illegalEligible = payload.rows.find(
  (row) => row.strategyEligiblePaper && row.catalogStatus !== "callback_verified",
);
if (illegalEligible) {
  throw new Error(
    `only callback_verified routes may be strategy eligible: ${JSON.stringify(illegalEligible)}`,
  );
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      routeCount: payload.summary.routeCount,
      registeredFuturesProductCount: payload.summary.registeredFuturesProductCount,
      callbackVerifiedRouteCount: payload.summary.callbackVerifiedRouteCount,
      officialCatalogRequiredRouteCount: payload.summary.officialCatalogRequiredRouteCount,
      assertions: [
        "full futures registry is covered",
        "TXF current and next-month are callback verified in fixture",
        "GC month candidate remains official-catalog gated",
        "Energy CL/QM/MCL/BZ/NG routes use official catalog evidence but remain callback-gated",
        "NQ current-month blocks non-quarterly month",
        "strategy eligibility requires callback_verified",
      ],
    },
    null,
    2,
  ),
);
