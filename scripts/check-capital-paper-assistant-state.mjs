import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCapitalPaperAssistantState,
  readCapitalPaperAssistantState,
  writeCapitalPaperAssistantState,
} from "./openclaw-capital-paper-assistant-state.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function baseQuoteStatus(status = "ready", overrides = {}) {
  return {
    schema: "openclaw.capital.quote-status.v1",
    generatedAt: "2026-05-06T19:00:00.000Z",
    provider: "capital",
    source: "CapitalHftService health dashboard",
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    status,
    ready: status === "ready",
    reason: "fixture",
    strategyGate: {
      ready: status === "ready",
      status: status === "ready" ? "allow_read_only_strategy_context" : "deny_strategy_context",
      reason: "fixture",
    },
    guard: {
      active: false,
      lastCode: "",
      nextAllowedAt: "",
      ...overrides.guard,
    },
    quoteProof: {
      status: "confirmed",
      freshness: status === "stale" ? "stale" : "fresh",
      latestStock: "MXFFX999",
      latestStockName: "客小台現貨標的",
      freshnessStatus: status === "stale" ? "stale" : "fresh",
      freshnessAgeSeconds: status === "stale" ? 999999 : 60,
      maxFreshSeconds: 2,
      maxAllowedFreshAgeSeconds: 2,
      ...overrides.quoteProof,
    },
    completion: {
      queueCompleted: true,
      openClawReady: true,
      openClawCompleted: true,
      lastRunStatus: "subscription-window-accepted",
      quoteUniverseCount: 18404,
      distinctQuoteCodeCount: 14622,
      completionUniverseCount: 14622,
      completionBasis: "distinctQuoteCodeCount",
      nextStartIndex: 14622,
      ...overrides.completion,
    },
    monitors: {
      freshnessReady: status === "ready",
      mappingReady: true,
      classificationReady: true,
      allReadOnlyMonitorsReady: status === "ready",
      mappingFamilies: 409,
      classificationMappedRows: 14622,
      classificationDistinctQuoteCodes: 14622,
      ...overrides.monitors,
    },
    diagnostics: {
      bidAskUsable: status === "ready",
      blockers: status === "stale" ? ["freshness_stale", "bid_ask_not_usable"] : [],
      latestQuote: {
        receivedAt: "2026-05-06 19:00:00.000",
        eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
        message: "fixture",
        stockNo: "MXFFX999",
        stockName: "客小台現貨標的",
        close: "4113885",
        bid: status === "stale" ? "0" : "4113880",
        ask: status === "stale" ? "0" : "4113881",
        qty: "3",
      },
      ...overrides.diagnostics,
    },
    nextSafeTask:
      status === "stale"
        ? "等待 CapitalHftService 寫入更新的 quote event；不要登入、不要推進 StartIndex。"
        : "維持 heartbeat 健康檢查，不重跑全商品。",
    files: {
      dashboard: "",
      sourceDashboardPath: "",
      freshnessState: "",
      productMappingState: "",
      domesticOverseasState: "",
      ...overrides.files,
    },
    ...overrides,
  };
}

function baseLoopReport(status = "paper_intent_created", overrides = {}) {
  return {
    schema: "openclaw.capital.paper-automation-loop.v1",
    generatedAt: "2026-05-06T19:00:00.000Z",
    provider: "capital",
    mode: "paper",
    readOnlyQuoteOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    hftLikeAutomation: true,
    status,
    pump: {
      status: "fresh",
      ready: true,
      quote: {
        stockNo: "MXFFX999",
        stockName: "客小台現貨標的",
        eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
        receivedAt: "2026-05-06 19:00:00.000",
        ageSeconds: 1,
        freshness: "fresh",
        close: "4113885",
        bid: "4113880",
        ask: "4113881",
        qty: "3",
      },
    },
    architecture: {
      status: "passed",
      passed: 38,
      failed: 0,
      eventType: "capital.quote.ready",
      strategyGateReady: true,
    },
    readiness: {
      status: "ready",
      ready: true,
      failed: 0,
      quoteAgeSeconds: 1,
      maxQuoteAgeSeconds: 2,
      latestStock: "MXFFX999",
    },
    trading: {
      cycleId: "capital-paper-TEST",
      status,
      reason: "fixture",
      paperIntentCreated: status === "paper_intent_created",
      paperIntentId: status === "paper_intent_created" ? "capital-paper-TEST-intent" : "",
      quote: {
        stockNo: "MXFFX999",
        close: 41138.85,
        bid: 41138.8,
        ask: 41138.81,
        qty: 3,
      },
    },
    learning: {
      status: "candidate",
      paperEligible: false,
      liveEligible: false,
      counters: {
        totalCycles: 8,
        paperIntents: 1,
        readinessBlocks: 0,
        quoteBlocks: 0,
        consecutiveReadinessBlocks: 0,
        consecutiveReadyCycles: 1,
      },
    },
    files: {
      reportPath: "",
      streamPath: "",
      pumpReportPath: "",
      quoteStatePath: "",
      quoteStatusPath: "",
      runtimeEventPath: "",
      architectureReportPath: "",
      readinessPath: "",
      tradingCyclePath: "",
      paperIntentPath: "",
      learningRegistryPath: "",
      learningSummaryPath: "",
      ...overrides.files,
    },
    nextSafeTask:
      status === "paper_intent_created"
        ? "持續由 heartbeat 重跑 capital-hft:paper-loop；累積 paper learning，不啟用真實下單。"
        : "維持 paper-only learning，等待新的 SKQuoteLib quote callback 後再評估。",
    ...overrides,
  };
}

function baseLearningSummary(status = "candidate", overrides = {}) {
  return {
    schema: "openclaw.capital.paper-learning-summary.v1",
    generatedAt: "2026-05-06T19:00:00.000Z",
    provider: "capital",
    mode: "paper",
    readOnlyQuoteOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    hftLikeAutomation: true,
    status,
    strategyName: "capital-paper-microstructure-probe",
    paperEligible: false,
    liveEligible: false,
    registry: {
      status,
      paperEligible: false,
      liveEligible: false,
      rules: {
        status: "candidate",
        minReadyCyclesForPaper: 20,
        blockAfterConsecutiveReadinessBlocks: 20,
        promoteLiveAutomatically: false,
      },
      counters: {
        totalCycles: 8,
        paperIntents: 1,
        readinessBlocks: 0,
        quoteBlocks: 0,
        consecutiveReadinessBlocks: 0,
        consecutiveReadyCycles: 1,
      },
      lastObservation: {
        generatedAt: "2026-05-06T19:00:00.000Z",
        cycleId: "capital-paper-TEST",
        status: "paper_intent_created",
        reason: "fixture",
        latestStock: "MXFFX999",
        quoteAgeSeconds: 1,
        paperIntentId: "capital-paper-TEST-intent",
      },
    },
    summary: {
      totalCycles: 8,
      paperIntents: 1,
      readinessBlocks: 0,
      quoteBlocks: 0,
      consecutiveReadinessBlocks: 0,
      consecutiveReadyCycles: 1,
      minReadyCyclesForPaper: 20,
      blockAfterConsecutiveReadinessBlocks: 20,
      latestCycleId: "capital-paper-TEST",
      latestCycleStatus: "paper_intent_created",
      latestReason: "fixture",
      latestQuoteAgeSeconds: 1,
      latestPaperIntentId: "capital-paper-TEST-intent",
    },
    recommendation: {
      nextSafeTask:
        "持續由 heartbeat 重跑 capital-hft:paper-loop；累積 paper learning，不啟用真實下單。",
    },
    files: {
      registryPath: "",
      reportPath: "",
      ...overrides.files,
    },
    ...overrides,
  };
}

function basePromotionGate(status = "blocked", overrides = {}) {
  return {
    schema: "openclaw.capital.paper-promotion-gate.v1",
    generatedAt: "2026-05-06T19:00:00.000Z",
    provider: "capital",
    mode: "paper",
    readOnlyQuoteOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    hftLikeAutomation: true,
    status,
    promoted: false,
    summary: {
      status: "candidate",
      paperEligible: false,
      liveEligible: false,
      consecutiveReadyCycles: 1,
      minReadyCyclesForPaper: 20,
      consecutiveReadinessBlocks: 0,
      blockAfterConsecutiveReadinessBlocks: 20,
      latestCycleId: "capital-paper-TEST",
      latestReason: "fixture",
      latestQuoteAgeSeconds: 1,
      ...overrides.summary,
    },
    recommendation: {
      nextSafeTask: "維持 paper-only learning，等待新的 SKQuoteLib quote callback 後再評估。",
      ...overrides.recommendation,
    },
    checks: [
      {
        id: "promotion:summary-present",
        status: "pass",
        message: "Learning summary exists",
        evidence: { summaryPath: "fixture" },
      },
    ],
    files: {
      summaryPath: "",
      reportPath: "",
      registryPath: "",
      ...overrides.files,
    },
    ...overrides,
  };
}

function baseCronCheck(status = "passed", overrides = {}) {
  return {
    schema: "openclaw.capital.paper-cron-job-check.v1",
    generatedAt: "2026-05-06T19:00:00.000Z",
    status,
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    summary: {
      passed: 16,
      failed: 0,
      jobId: "fixture",
      enabled: true,
      nextRunAtMs: 1778093962521,
      nextRunAt: "2026-05-06T18:59:22.521Z",
      due: false,
      lastRunStatus: "ok",
      triggerStatus: "idle_duplicate_quote",
      quoteIsNew: false,
      quoteFresh: true,
      quoteAgeSeconds: 11175,
      bidAskUsable: false,
      burstStatus: "",
      paperIntents: 1,
      reason: "fixture",
      ...overrides.summary,
    },
    checks: [
      {
        id: "cron:single-job",
        status: "pass",
        message: "Exactly one Capital paper HFT trigger cron job exists",
        evidence: { count: 1, jobIds: ["fixture"] },
      },
    ],
    files: {
      jobsPath: "",
      statePath: "",
      triggerReportPath: "",
      reportPath: "",
      ...overrides.files,
    },
    nextSafeTask: "等待下一筆新的 SKQuoteLib quote callback，再查 trigger report 是否執行 burst。",
    ...overrides,
  };
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-paper-assistant-"));
const quoteStatusPath = path.join(tempRoot, ".openclaw", "quote", "capital-quote-status.json");
const loopReportPath = path.join(
  tempRoot,
  ".openclaw",
  "trading",
  "capital-paper-automation-loop-latest.json",
);
const learningSummaryPath = path.join(
  tempRoot,
  ".openclaw",
  "trading",
  "capital-paper-learning-summary.json",
);
const promotionGatePath = path.join(
  tempRoot,
  ".openclaw",
  "trading",
  "capital-paper-promotion-gate.json",
);
const cronCheckPath = path.join(
  tempRoot,
  ".openclaw",
  "trading",
  "capital-paper-cron-job-check.json",
);
const strategyBookPath = path.join(
  tempRoot,
  "reports",
  "hermes-agent",
  "state",
  "capital-hft-strategy-book-latest.json",
);
const chartBarsPath = path.join(tempRoot, ".openclaw", "bars", "TX00-1min-bars.jsonl");
const latestFastOrderReviewPath = path.join(
  tempRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-telegram-fast-order-review-latest.json",
);
const latestFastOrderPaperExecutionPath = path.join(
  tempRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-telegram-fast-order-paper-execution-latest.json",
);
const fastOrderReviewJsonlPath = path.join(
  tempRoot,
  ".openclaw",
  "trading",
  "telegram-fast-order-review-decisions.jsonl",
);
const fastOrderPaperExecutionJsonlPath = path.join(
  tempRoot,
  ".openclaw",
  "trading",
  "telegram-fast-order-paper-executions.jsonl",
);
const paperIntentPath = path.join(tempRoot, ".openclaw", "trading", "capital-paper-intents.jsonl");
const latestPaperIntentEpochPath = path.join(
  tempRoot,
  ".openclaw",
  "trading",
  "capital-paper-intents-rejected-latest.json",
);
const paperIntentEpochsPath = path.join(
  tempRoot,
  ".openclaw",
  "trading",
  "capital-paper-intents-epochs.jsonl",
);

await writeJson(quoteStatusPath, baseQuoteStatus("ready"));
await writeJson(loopReportPath, baseLoopReport("paper_intent_created"));
await writeJson(learningSummaryPath, baseLearningSummary("candidate"));
await writeJson(promotionGatePath, basePromotionGate("blocked"));
await writeJson(cronCheckPath, baseCronCheck("passed"));
await writeJson(strategyBookPath, {
  schema: "openclaw.capital.strategy-book.v1",
  generatedAt: "2026-05-06T19:00:00.000Z",
  status: "pass",
  ready: true,
  summary: {
    strategyCount: 3,
    enabledStrategyCount: 3,
    disabledStrategyCount: 0,
  },
  strategies: [
    { name: "MACD", enabled: true, weight: 1, paramKeys: ["fast", "slow", "signal"] },
    { name: "RSI", enabled: true, weight: 1, paramKeys: ["period"] },
    { name: "VWAP", enabled: true, weight: 1.2, paramKeys: ["devMult"] },
  ],
  simulation: {
    status: "pass",
    mode: "paper-only-fixture",
    symbolsSimulated: 3,
    paperIntentCount: 3,
    realQuoteVerified: false,
    realQuoteBlockerCode: "fresh_quote_readback_not_available_or_stale",
  },
  safety: {
    sentOrder: false,
    postedCommand: false,
    wroteBroker: false,
    livePromotionRequired: true,
  },
  nextSafeTask: "fixture strategy book ready; wait for fresh quote alignment.",
});
await fs.mkdir(path.dirname(chartBarsPath), { recursive: true });
await fs.writeFile(
  chartBarsPath,
  `${JSON.stringify({
    symbol: "TX00",
    date: "2026-05-06",
    time: "08:45",
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1,
  })}\n`,
  "utf8",
);
await writeJson(latestFastOrderReviewPath, {
  schema: "openclaw.trading.fast-order-review.v1",
  generatedAt: "2026-05-06T19:01:00.000Z",
  status: "paper_execution_recorded",
  decision: "approve_paper",
  intentId: "capital-paper-TEST-intent",
  ticket: { symbol: "MXFFX999", side: "buy", quantity: 1 },
  paperExecution: {
    recorded: true,
    paperOnly: true,
    symbol: "MXFFX999",
    side: "buy",
    quantity: 1,
  },
  audit: {
    sentBrokerOrder: false,
    brokerCommandEnabled: false,
    submissionCommand: "",
  },
});
await writeJson(latestFastOrderPaperExecutionPath, {
  schema: "openclaw.trading.fast-order-paper-execution.v1",
  generatedAt: "2026-05-06T19:01:00.000Z",
  status: "paper_execution_recorded",
  recorded: true,
  paperOnly: true,
  intentId: "capital-paper-TEST-intent",
  symbol: "MXFFX999",
  side: "buy",
  quantity: 1,
  sentBrokerOrder: false,
  brokerCommandEnabled: false,
  submissionCommand: "",
});
await fs.mkdir(path.dirname(fastOrderReviewJsonlPath), { recursive: true });
await fs.writeFile(
  fastOrderReviewJsonlPath,
  `${JSON.stringify({
    generatedAt: "2026-05-06T18:59:00.000Z",
    status: "denied",
    decision: "deny",
    intentId: "capital-paper-DENY",
    ticket: { symbol: "MXFFX999", side: "sell", quantity: 1 },
  })}\n`,
  "utf8",
);
await fs.writeFile(
  fastOrderPaperExecutionJsonlPath,
  `${JSON.stringify({
    generatedAt: "2026-05-06T19:01:00.000Z",
    status: "paper_execution_recorded",
    intentId: "capital-paper-TEST-intent",
    symbol: "MXFFX999",
    side: "buy",
    quantity: 1,
  })}\n`,
  "utf8",
);
await fs.writeFile(
  paperIntentPath,
  `${JSON.stringify({
    intentId: "capital-paper-TEST-intent",
    intentRunId: "capital-paper-run-TEST",
    symbol: "MXFFX999",
    side: "buy",
    quantity: 1,
    paperOnly: true,
  })}\n`,
  "utf8",
);
const latestPaperIntentEpoch = {
  schema: "openclaw.capital.paper-intent-epoch.v1",
  generatedAt: "2026-05-06T18:58:00.000Z",
  status: "superseded",
  reason: "new_intent_epoch",
  activeIntentsPath: paperIntentPath,
  intentRunId: "capital-paper-run-PREV",
  previousRecordCount: 0,
  previousDigest: "",
  safetyLock: {
    allowLiveTrading: false,
    writeBrokerOrders: false,
    promoteLiveAutomatically: false,
  },
};
await writeJson(latestPaperIntentEpochPath, latestPaperIntentEpoch);
await fs.writeFile(paperIntentEpochsPath, `${JSON.stringify(latestPaperIntentEpoch)}\n`, "utf8");

const fresh = await readCapitalPaperAssistantState({ repoRoot: tempRoot });
if (fresh.report.schema !== "openclaw.capital.paper-assistant-state.v1") {
  throw new Error(`unexpected schema: ${fresh.report.schema}`);
}
if (!Object.is(fresh.report.ready, true)) {
  throw new Error(`expected ready assistant state, got ${JSON.stringify(fresh.report)}`);
}
if (fresh.report.status !== "paper_intent_created") {
  throw new Error(`expected paper_intent_created status, got ${fresh.report.status}`);
}
if (fresh.report.flowDecision?.schema !== "openclaw.capital.paper-assistant-flow-decision.v1") {
  throw new Error("assistant state must expose flowDecision schema");
}
if (fresh.report.flowDecision.decisionCode !== "continue_paper_learning") {
  throw new Error(
    `expected continue_paper_learning flow decision, got ${fresh.report.flowDecision.decisionCode}`,
  );
}
if (!Object.is(fresh.report.flowDecision.readyForPaperCycle, true)) {
  throw new Error("fresh assistant state must be ready for the next paper cycle");
}
if (!Object.is(fresh.report.flowDecision.liveOrderAllowed, false)) {
  throw new Error("flow decision must keep live orders disabled");
}
if (!Array.isArray(fresh.report.flowDecision.gates) || fresh.report.flowDecision.gates.length < 8) {
  throw new Error("flow decision must expose the intelligent decision matrix gates");
}
const freshQuoteGate = fresh.report.flowDecision.gates.find(
  (gate) => gate.id === "quote_freshness",
);
if (freshQuoteGate?.status !== "pass") {
  throw new Error("fresh assistant state must pass quote_freshness gate");
}
const freshLiveGate = fresh.report.flowDecision.gates.find((gate) => gate.id === "live_promotion");
if (freshLiveGate?.status !== "blocked") {
  throw new Error("flow decision must keep live_promotion blocked on the paper surface");
}
if (fresh.report.chartStrategy?.schema !== "openclaw.capital.chart-strategy-state.v1") {
  throw new Error("assistant state must expose chartStrategy schema");
}
if (!Object.is(fresh.report.chartStrategy.ready, true)) {
  throw new Error("fresh assistant state must expose ready chart strategy state");
}
if (!Object.is(fresh.report.chartStrategy.chartData.ready, true)) {
  throw new Error("chart strategy state must see chart bar data");
}
if (fresh.report.chartStrategy.strategyBook.enabledStrategyCount !== 3) {
  throw new Error("chart strategy state must expose enabled strategy count");
}
const chartStrategyGate = fresh.report.flowDecision.gates.find(
  (gate) => gate.id === "chart_strategy",
);
if (chartStrategyGate?.status !== "pass") {
  throw new Error("fresh assistant state must pass chart_strategy gate");
}
if (fresh.report.chartStrategy.fastOrderPaperPattern?.pattern !== "mixed-paper-pattern") {
  throw new Error("chart strategy state must expose mixed fast-order paper pattern");
}
if (fresh.report.chartStrategy.strategySummary?.fastOrderPaperPattern !== "mixed-paper-pattern") {
  throw new Error("chart strategy summary must expose fast-order paper pattern");
}
if (fresh.report.summary.fastOrderPaperPattern !== "mixed-paper-pattern") {
  throw new Error("assistant summary must expose fast-order paper pattern");
}
if (
  fresh.report.summary.fastOrderPaperSuccessCount !== 1 ||
  fresh.report.summary.fastOrderPaperFailureCount !== 1
) {
  throw new Error("assistant summary must expose fast-order paper success/failure counts");
}
const fastOrderPatternGate = fresh.report.flowDecision.gates.find(
  (gate) => gate.id === "fast_order_paper_pattern",
);
if (fastOrderPatternGate?.status !== "pass") {
  throw new Error("fresh assistant state must pass fast_order_paper_pattern gate");
}
if (!Object.is(fresh.report.learning.fastOrderPaperPattern?.sentBrokerOrder, false)) {
  throw new Error("fast-order paper pattern must keep broker order submission locked");
}
if (fresh.report.intentLifecycle?.schema !== "openclaw.capital.paper-intent-lifecycle-state.v1") {
  throw new Error("assistant state must expose paper intent lifecycle schema");
}
if (fresh.report.intentLifecycle.currentActiveRecordCount !== 1) {
  throw new Error("fresh assistant state must expose current active paper intent count");
}
if (fresh.report.summary.activeIntentRecords !== 1) {
  throw new Error("assistant summary must expose active paper intent records");
}
const orderLifecycleGate = fresh.report.flowDecision.gates.find(
  (gate) => gate.id === "order_lifecycle",
);
if (orderLifecycleGate?.status !== "pass") {
  throw new Error("fresh assistant state must pass order_lifecycle with active paper intent");
}
if (!Object.is(fresh.report.intentLifecycle.safety?.liveOrderAllowed, false)) {
  throw new Error("paper intent lifecycle must keep live orders disabled");
}
if (!fresh.report.recommendation.nextSafeTask.includes("paper-loop")) {
  throw new Error("assistant recommendation must keep paper loop running");
}
if (
  !Object.is(fresh.report.readOnlyQuoteOnly, true) ||
  !Object.is(fresh.report.loginAttempted, false) ||
  !Object.is(fresh.report.liveTradingEnabled, false) ||
  !Object.is(fresh.report.writeTradingEnabled, false) ||
  !Object.is(fresh.report.brokerOrderPathEnabled, false)
) {
  throw new Error("assistant state must stay read-only and no-trading");
}

const outputPath = path.join(tempRoot, ".openclaw", "ui", "capital-paper-assistant-state.json");
await writeCapitalPaperAssistantState(fresh.report, outputPath);
await fs.access(outputPath);
await fs.access(`${outputPath}.sha256`);

await writeJson(quoteStatusPath, baseQuoteStatus("stale"));
const stale = await readCapitalPaperAssistantState({ repoRoot: tempRoot });
if (stale.report.status !== "blocked_quote_stale") {
  throw new Error(`expected stale quote blocking, got ${stale.report.status}`);
}
if (stale.report.flowDecision?.decisionCode !== "wait_for_quote_callback") {
  throw new Error(
    `expected wait_for_quote_callback flow decision, got ${stale.report.flowDecision?.decisionCode}`,
  );
}
if (!Object.is(stale.report.flowDecision.readyForPaperCycle, false)) {
  throw new Error("stale assistant state must not be ready for paper cycle");
}
const staleQuoteGate = stale.report.flowDecision.gates.find(
  (gate) => gate.id === "quote_freshness",
);
if (staleQuoteGate?.status !== "blocked") {
  throw new Error("stale assistant state must block quote_freshness gate");
}
if (stale.report.ready) {
  throw new Error("stale assistant state must not be ready");
}
if (!stale.report.assistant.operatorAction.includes("SKQuoteLib quote callback")) {
  throw new Error("stale operator action must point to quote callback refresh");
}
if (!Array.isArray(stale.report.assistant.entrypoints)) {
  throw new Error("stale assistant state must expose entrypoints");
}
if (!stale.report.assistant.entrypoints.includes("pnpm capital-hft:auto-trading")) {
  throw new Error("stale assistant state must expose auto-trading entrypoint");
}
if (!stale.report.assistant.entrypoints.includes("pnpm capital-hft:auto-trading-loop")) {
  throw new Error("stale assistant state must expose auto-trading-loop entrypoint");
}
if (!Array.isArray(stale.report.quote.diagnostics.blockers)) {
  throw new Error("stale assistant state must expose quote blockers");
}
if (!stale.report.quote.diagnostics.blockers.includes("freshness_stale")) {
  throw new Error("stale assistant state must flag freshness_stale blocker");
}
if (!stale.report.quote.diagnostics.blockers.includes("bid_ask_not_usable")) {
  throw new Error("stale assistant state must flag bid_ask_not_usable blocker");
}

await fs.writeFile(paperIntentPath, "", "utf8");
await writeJson(
  loopReportPath,
  baseLoopReport("blocked_readiness", {
    trading: {
      cycleId: "capital-paper-BLOCKED",
      status: "blocked_readiness",
      reason: "fixture blocked readiness; no current paper intent",
      paperIntentCreated: false,
      paperIntentId: "",
      quote: {
        stockNo: "MXFFX999",
        close: 41138.85,
        bid: 41138.8,
        ask: 41138.81,
        qty: 3,
      },
    },
    strategy: {
      status: "blocked_symbol_not_ready",
      liveStillBlocked: true,
    },
  }),
);
const blockedNoIntent = await readCapitalPaperAssistantState({ repoRoot: tempRoot });
if (blockedNoIntent.report.paperLoopBlocker?.status !== "blocked_no_current_paper_intent") {
  throw new Error("assistant state must expose no-current-intent blocker");
}
if (blockedNoIntent.report.intentLifecycle.latestEpoch?.reason !== "new_intent_epoch") {
  throw new Error("assistant state must expose latest paper intent epoch reason");
}
if (
  blockedNoIntent.report.summary.currentBlockerReason !==
  "fixture blocked readiness; no current paper intent"
) {
  throw new Error("assistant summary must expose current paper-loop blocker reason");
}
const blockedOrderLifecycleGate = blockedNoIntent.report.flowDecision.gates.find(
  (gate) => gate.id === "order_lifecycle",
);
if (blockedOrderLifecycleGate?.status !== "warn") {
  throw new Error("blocked no-intent state must warn through order_lifecycle with epoch evidence");
}

const built = buildCapitalPaperAssistantState({
  quoteStatus: baseQuoteStatus("ready"),
  loopReport: baseLoopReport("paper_intent_created"),
  learningSummary: baseLearningSummary("candidate"),
  promotionGate: basePromotionGate("blocked"),
  cronCheck: baseCronCheck("passed"),
  fastOrderAudit: {
    latestReview: { status: "paper_execution_recorded", decision: "approve_paper" },
    latestPaperExecution: { status: "paper_execution_recorded", recorded: true, paperOnly: true },
    history: { entries: [{ kind: "review", status: "denied", decision: "deny" }] },
  },
  intentLifecycle: {
    currentActiveRecordCount: 0,
    latestEpoch: latestPaperIntentEpoch,
    safety: { liveOrderAllowed: false },
  },
});
if (built.summary.quoteStatus !== "ready" || built.summary.cronStatus !== "passed") {
  throw new Error("assistant summary must expose source gate statuses");
}
if (built.summary.fastOrderPaperPattern !== "mixed-paper-pattern") {
  throw new Error("built assistant state must expose fast-order paper pattern in summary");
}
if (built.summary.latestIntentEpochReason !== "new_intent_epoch") {
  throw new Error("built assistant state must expose latest intent epoch in summary");
}

process.stdout.write("CAPITAL_PAPER_ASSISTANT_STATE_CHECK=OK\n");
