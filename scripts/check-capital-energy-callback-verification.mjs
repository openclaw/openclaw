import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCapitalEnergyCallbackVerification } from "./openclaw-capital-energy-callback-verification.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-energy-callback-"));
const reportableStatePath = path.join(tempRoot, "capital-reportable-quote-state.json");
const rotationReportPath = path.join(tempRoot, "openclaw-capital-overseas-product-rotation.json");
const freshIso = new Date(Date.now() - 1000).toISOString();

function routeFixture(marketCode, routingMode, selectedContract, nextCandidate, continuousSymbol) {
  return {
    marketCode,
    routingMode,
    catalogStatus: "requires_subscription_callback",
    routeAlignmentStatus: "listed_selected_symbols",
    selectedSymbols: [`NYM,${selectedContract}`, selectedContract],
    unlistedSelectedSymbols: [],
    subscriptionCandidates: [selectedContract, nextCandidate, continuousSymbol],
    paperStrategyAllowed: false,
    liveTradingEnabled: false,
    writeBrokerOrders: false,
  };
}

await fs.writeFile(
  reportableStatePath,
  `${JSON.stringify(
    {
      schema: "openclaw.capital.reportable-quote-state.v1",
      generatedAt: freshIso,
      readOnly: true,
      loginAttempted: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      sentOrder: false,
      quotePolicy: "fresh_matched_only",
      summary: {
        reportableCount: 1,
        blockedCount: 1,
      },
      reportableQuotes: [
        {
          query: "NG2606",
          symbol: "NG2606",
          source: "overseas",
          close: 3.15,
          bid: 3.149,
          ask: 3.151,
          receivedAt: freshIso,
          sourceFile: "fixture-os-symbol-cache.json",
        },
      ],
      blockedQuotes: [
        {
          symbol: "CL2607",
          source: "overseas",
          diagnosis: "session_closed",
          blockedCategory: "session_closed",
          reason: "closed_session_stale",
          unblockCondition: "market session opens and a fresh matched callback arrives.",
          lastEvent: {
            stockNo: "CL2607",
            close: 97,
            bid: 96.9,
            ask: 97.1,
            receivedAt: "2026-05-24T23:53:00+08:00",
            sourceFile: "fixture-os-symbol-cache.json",
          },
        },
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await fs.writeFile(
  rotationReportPath,
  `${JSON.stringify(
    {
      schema: "openclaw.capital.overseas-product-rotation.v1",
      energyContractSubscriptionPlan: {
        schema: "openclaw.capital.energy-contract-subscription-plan.v1",
        routeCount: 10,
        candidateCount: 15,
        candidateCodes: [
          "CL2607",
          "CL2608",
          "CL0000",
          "QM2607",
          "QM2608",
          "QM0000",
          "MCL2607",
          "MCL2608",
          "MCL0000",
          "BZ2607",
          "BZ2608",
          "BZ0000",
          "NG2606",
          "NG2607",
          "NG0000",
        ],
        routes: [
          routeFixture("CL", "current-month", "CL2607", "CL2608", "CL0000"),
          routeFixture("CL", "next-month", "CL2608", "CL2607", "CL0000"),
          routeFixture("QM", "current-month", "QM2607", "QM2608", "QM0000"),
          routeFixture("QM", "next-month", "QM2608", "QM2607", "QM0000"),
          routeFixture("MCL", "current-month", "MCL2607", "MCL2608", "MCL0000"),
          routeFixture("MCL", "next-month", "MCL2608", "MCL2607", "MCL0000"),
          routeFixture("BZ", "current-month", "BZ2607", "BZ2608", "BZ0000"),
          routeFixture("BZ", "next-month", "BZ2608", "BZ2607", "BZ0000"),
          routeFixture("NG", "current-month", "NG2606", "NG2607", "NG0000"),
          routeFixture("NG", "next-month", "NG2607", "NG2606", "NG0000"),
        ],
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const payload = await buildCapitalEnergyCallbackVerification({
  rotationReport: rotationReportPath,
  reportableState: reportableStatePath,
});

if (payload.schema !== "openclaw.capital.energy-callback-verification.v1") {
  throw new Error(`unexpected schema: ${payload.schema}`);
}
if (
  !payload.readOnly ||
  payload.loginAttempted ||
  payload.subscriptionAttemptedByThisScript ||
  payload.liveTradingEnabled ||
  payload.writeTradingEnabled ||
  payload.sentOrder
) {
  throw new Error("energy callback verification must stay read-only/no-subscribe/no-trade");
}
if (payload.summary.routeCount !== 10 || payload.summary.candidateCount < 10) {
  throw new Error(`unexpected energy coverage: ${JSON.stringify(payload.summary)}`);
}
if (
  payload.safety.liveTradingEnabled ||
  payload.safety.writeBrokerOrders ||
  payload.safety.sentOrder
) {
  throw new Error(`unexpected safety flags: ${JSON.stringify(payload.safety)}`);
}

const ngCurrent = payload.routes.find(
  (route) => route.marketCode === "NG" && route.routingMode === "current-month",
);
if (
  !ngCurrent ||
  ngCurrent.callbackStatus !== "callback_verified" ||
  ngCurrent.paperStrategyEligible !== true ||
  ngCurrent.unlistedSelectedSymbols.length !== 0 ||
  !ngCurrent.candidateEvidence.some(
    (item) => item.symbol === "NG2606" && item.callbackStatus === "callback_verified",
  )
) {
  throw new Error(
    `NG current-month must become paper-eligible after listed exact callback: ${JSON.stringify(ngCurrent)}`,
  );
}

const ngNext = payload.routes.find(
  (route) => route.marketCode === "NG" && route.routingMode === "next-month",
);
if (
  !ngNext ||
  ngNext.callbackStatus !== "requires_subscription_callback" ||
  ngNext.paperStrategyEligible !== false ||
  !ngNext.candidateEvidence.some(
    (item) => item.symbol === "NG2607" && item.callbackStatus === "requires_subscription_callback",
  )
) {
  throw new Error(`NG next-month must wait for listed exact callback: ${JSON.stringify(ngNext)}`);
}

const clCurrent = payload.routes.find(
  (route) => route.marketCode === "CL" && route.routingMode === "current-month",
);
if (
  !clCurrent ||
  clCurrent.callbackStatus !== "blocked_callback_or_session" ||
  clCurrent.paperStrategyEligible !== false ||
  !clCurrent.candidateEvidence.some(
    (item) => item.symbol === "CL2607" && item.callbackStatus === "blocked_callback_or_session",
  )
) {
  throw new Error(
    `CL current-month must stay blocked on session callback evidence: ${JSON.stringify(clCurrent)}`,
  );
}

const liveEligible = payload.routes.find(
  (route) => route.liveTradingEnabled || route.writeBrokerOrders,
);
if (liveEligible) {
  throw new Error(`no energy route may be live/write eligible: ${JSON.stringify(liveEligible)}`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      status: "PASS",
      routeCount: payload.summary.routeCount,
      candidateCount: payload.summary.candidateCount,
      callbackVerifiedRouteCount: payload.summary.callbackVerifiedRouteCount,
      paperStrategyEligibleRouteCount: payload.summary.paperStrategyEligibleRouteCount,
      assertions: [
        "energy active-page candidates are verified from reportable quote state",
        "exact listed contract callback can unlock paper-only route",
        "rerouted selected months stay listed before paper eligibility",
        "live and broker writes stay disabled",
      ],
    },
    null,
    2,
  )}\n`,
);
