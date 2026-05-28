import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function defaultQuoteStatusPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-quote-status.json");
}

function defaultLoopReportPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-automation-loop-latest.json");
}

function defaultLearningSummaryPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-learning-summary.json");
}

function defaultPromotionGatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-promotion-gate.json");
}

function defaultCronCheckPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-cron-job-check.json");
}

function defaultTickDiagnosticPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-tick-diagnostic.json");
}

function defaultStartupStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "ui", "auto-trading-watch-startup-state.json");
}

function defaultServiceStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "service", "auto-trading-watch-service.json");
}

function defaultStrategyBookPaths(repoRoot) {
  return [
    path.join(
      repoRoot,
      "reports",
      "hermes-agent",
      "state",
      "capital-hft-strategy-book-latest.json",
    ),
    path.join(repoRoot, ".openclaw", "capital-hft-strategy-book.json"),
  ];
}

function defaultFastOrderAuditPaths(repoRoot) {
  return {
    latestIntent: path.join(
      repoRoot,
      "reports",
      "hermes-agent",
      "state",
      "openclaw-telegram-fast-order-intent-latest.json",
    ),
    latestReview: path.join(
      repoRoot,
      "reports",
      "hermes-agent",
      "state",
      "openclaw-telegram-fast-order-review-latest.json",
    ),
    latestPaperExecution: path.join(
      repoRoot,
      "reports",
      "hermes-agent",
      "state",
      "openclaw-telegram-fast-order-paper-execution-latest.json",
    ),
    intentsJsonl: path.join(repoRoot, ".openclaw", "trading", "telegram-fast-order-intents.jsonl"),
    reviewsJsonl: path.join(
      repoRoot,
      ".openclaw",
      "trading",
      "telegram-fast-order-review-decisions.jsonl",
    ),
    paperExecutionsJsonl: path.join(
      repoRoot,
      ".openclaw",
      "trading",
      "telegram-fast-order-paper-executions.jsonl",
    ),
  };
}

function defaultChartBarPaths(repoRoot) {
  return [
    path.join(repoRoot, ".openclaw", "bars", "TX00-1min-bars.jsonl"),
    path.join(repoRoot, ".openclaw", "bars", "TXF-1m.jsonl"),
    path.join(repoRoot, ".openclaw", "bars", "merged-clean", "TXF-qmd-1m.jsonl"),
  ];
}

function defaultPaperIntentLifecyclePaths(repoRoot) {
  const tradingDir = path.join(repoRoot, ".openclaw", "trading");
  return {
    activeIntents: path.join(tradingDir, "capital-paper-intents.jsonl"),
    latestEpoch: path.join(tradingDir, "capital-paper-intents-rejected-latest.json"),
    epochs: path.join(tradingDir, "capital-paper-intents-epochs.jsonl"),
  };
}

function defaultOutputPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "ui", "capital-paper-assistant-state.json");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} not found: ${filePath}`, { cause: error });
    }
    throw new Error(
      `Invalid ${label} JSON: ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function readOptionalJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function readOptionalText(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function readFirstOptionalJson(filePaths, fallback = {}) {
  for (const filePath of filePaths) {
    try {
      const value = JSON.parse(await fs.readFile(filePath, "utf8"));
      return { value, filePath };
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return { value: fallback, filePath: "" };
}

function jsonlLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readLatestJsonLines(filePath, limit = 50) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const rows = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit);
    return rows
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((item) => item && typeof item === "object" && !Array.isArray(item));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readChartBarSummaries(filePaths) {
  const summaries = [];
  for (const filePath of filePaths) {
    try {
      const stat = await fs.stat(filePath);
      summaries.push({
        path: filePath,
        exists: true,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      summaries.push({
        path: filePath,
        exists: false,
        sizeBytes: 0,
        updatedAt: "",
      });
    }
  }
  return summaries;
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

function bool(value) {
  return value === true;
}

function numberOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stringOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function fastOrderTicketFrom(raw) {
  return asRecord(raw?.ticket) || asRecord(raw?.paperExecution) || raw || {};
}

function fastOrderHistoryEntry(raw, kind, sourcePath) {
  const ticket = fastOrderTicketFrom(raw);
  return {
    kind,
    generatedAt: stringOr(raw?.generatedAt, ""),
    intentId: stringOr(raw?.intentId, "unknown"),
    status: stringOr(raw?.status, kind === "paper_execution" ? "paper_execution_recorded" : ""),
    decision: stringOr(raw?.decision, kind === "paper_execution" ? "approve_paper" : ""),
    symbol: stringOr(raw?.symbol ?? ticket?.symbol, "TX00"),
    side: stringOr(raw?.side ?? ticket?.side, "wait"),
    quantity: numberOr(raw?.quantity ?? ticket?.quantity, 1),
    paperOnly: true,
    sentBrokerOrder: false,
    brokerCommandEnabled: false,
    submissionCommand: "",
    sourcePath,
  };
}

function compareFastOrderHistoryDesc(left, right) {
  const leftMs = Date.parse(stringOr(left?.generatedAt, ""));
  const rightMs = Date.parse(stringOr(right?.generatedAt, ""));
  return (Number.isFinite(rightMs) ? rightMs : 0) - (Number.isFinite(leftMs) ? leftMs : 0);
}

function isFastOrderPaperSuccessEntry(entry) {
  return (
    stringOr(entry?.kind, "") === "paper_execution" ||
    stringOr(entry?.decision, "") === "approve_paper" ||
    stringOr(entry?.status, "") === "paper_execution_recorded"
  );
}

function isFastOrderPaperFailureEntry(entry) {
  return stringOr(entry?.decision, "") === "deny" || stringOr(entry?.status, "") === "denied";
}

async function readFastOrderAuditState(repoRoot) {
  const paths = defaultFastOrderAuditPaths(repoRoot);
  const [
    latestIntent,
    latestReview,
    latestPaperExecution,
    intentLines,
    reviewLines,
    paperExecutionLines,
  ] = await Promise.all([
    readOptionalJson(paths.latestIntent, null),
    readOptionalJson(paths.latestReview, null),
    readOptionalJson(paths.latestPaperExecution, null),
    readLatestJsonLines(paths.intentsJsonl),
    readLatestJsonLines(paths.reviewsJsonl),
    readLatestJsonLines(paths.paperExecutionsJsonl),
  ]);
  const entries = [
    ...intentLines.map((item) => fastOrderHistoryEntry(item, "intent", paths.intentsJsonl)),
    ...reviewLines.map((item) => fastOrderHistoryEntry(item, "review", paths.reviewsJsonl)),
    ...paperExecutionLines.map((item) =>
      fastOrderHistoryEntry(item, "paper_execution", paths.paperExecutionsJsonl),
    ),
  ].sort(compareFastOrderHistoryDesc);
  const page = entries.slice(0, 5);
  const repoRelative = Object.fromEntries(
    Object.entries(paths).map(([key, value]) => [key, path.relative(repoRoot, value)]),
  );
  return {
    schema: "openclaw.trading.fast-order-audit-snapshot.v1",
    generatedAt: new Date().toISOString(),
    status:
      latestIntent || latestReview || latestPaperExecution || entries.length > 0
        ? "loaded"
        : "empty",
    latestIntent,
    latestReview,
    latestPaperExecution,
    safety: {
      sentBrokerOrder: false,
      brokerCommandEnabled: false,
      submissionCommand: "",
    },
    readTargets: repoRelative,
    history: {
      filter: "all",
      offset: 0,
      limit: 5,
      total: entries.length,
      returned: page.length,
      entries: page,
    },
  };
}

function compactIntentEpoch(epoch) {
  if (!asRecord(epoch)) {
    return null;
  }
  const safetyLock = asRecord(epoch.safetyLock) || {};
  return {
    schema: stringOr(epoch.schema, ""),
    generatedAt: stringOr(epoch.generatedAt, ""),
    status: stringOr(epoch.status, ""),
    reason: stringOr(epoch.reason, ""),
    activeIntentsPath: stringOr(epoch.activeIntentsPath, ""),
    intentRunId: stringOr(epoch.intentRunId, ""),
    previousRecordCount: numberOr(epoch.previousRecordCount, 0),
    previousDigest: stringOr(epoch.previousDigest, ""),
    safetyLock: {
      allowLiveTrading: bool(safetyLock.allowLiveTrading),
      writeBrokerOrders: bool(safetyLock.writeBrokerOrders),
      promoteLiveAutomatically: bool(safetyLock.promoteLiveAutomatically),
    },
  };
}

async function readPaperIntentLifecycleState(
  repoRoot,
  paths = defaultPaperIntentLifecyclePaths(repoRoot),
) {
  const [latestEpochRaw, activeText, epochHistory] = await Promise.all([
    readOptionalJson(paths.latestEpoch, null),
    readOptionalText(paths.activeIntents, ""),
    readLatestJsonLines(paths.epochs, 5),
  ]);
  const activeLines = jsonlLines(activeText);
  const latestEpoch = compactIntentEpoch(latestEpochRaw);
  const readTargets = Object.fromEntries(
    Object.entries(paths).map(([key, value]) => [key, path.relative(repoRoot, value)]),
  );
  return {
    schema: "openclaw.capital.paper-intent-lifecycle-state.v1",
    status:
      activeLines.length > 0
        ? "active_intents_present"
        : latestEpoch
          ? `no_active_intents_latest_${latestEpoch.status || "epoch"}`
          : "no_active_intents_no_epoch",
    currentActiveRecordCount: activeLines.length,
    currentActiveDigest: activeLines.length > 0 ? sha256Text(`${activeLines.join("\n")}\n`) : "",
    latestEpoch,
    latestEpochEvidenceAvailable: Boolean(latestEpoch),
    epochHistoryReturned: epochHistory.length,
    epochHistory: epochHistory.map(compactIntentEpoch).filter(Boolean),
    safety: {
      paperOnly: true,
      liveOrderAllowed: false,
      sentBrokerOrder: false,
      brokerCommandEnabled: false,
      submissionCommand: "",
      latestEpochAllowLiveTrading: bool(latestEpoch?.safetyLock?.allowLiveTrading),
      latestEpochWriteBrokerOrders: bool(latestEpoch?.safetyLock?.writeBrokerOrders),
      latestEpochPromoteLiveAutomatically: bool(latestEpoch?.safetyLock?.promoteLiveAutomatically),
    },
    readTargets,
  };
}

function buildFastOrderPaperPattern(fastOrderAudit = {}) {
  const latestIntent = asRecord(fastOrderAudit?.latestIntent);
  const latestReview = asRecord(fastOrderAudit?.latestReview);
  const latestPaperExecution = asRecord(fastOrderAudit?.latestPaperExecution);
  const reviewPaper = asRecord(latestReview?.paperExecution);
  const intentTicket = asRecord(latestIntent?.ticket);
  const history = asRecord(fastOrderAudit?.history);
  const historyEntries = Array.isArray(history?.entries)
    ? history.entries.filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];
  const historySuccessCount = historyEntries.filter(isFastOrderPaperSuccessEntry).length;
  const historyFailureCount = historyEntries.filter(isFastOrderPaperFailureEntry).length;
  const latestReviewDecision = stringOr(latestReview?.decision, "unknown");
  const latestReviewStatus = stringOr(latestReview?.status, "unknown");
  const latestPaperSuccess =
    latestPaperExecution?.recorded === true ||
    latestPaperExecution?.paperOnly === true ||
    latestReviewDecision === "approve_paper" ||
    latestReviewStatus === "paper_execution_recorded";
  const latestPaperFailure = latestReviewDecision === "deny" || latestReviewStatus === "denied";
  const successCount = Math.max(historySuccessCount, latestPaperSuccess ? 1 : 0);
  const failureCount = Math.max(historyFailureCount, latestPaperFailure ? 1 : 0);
  const pattern =
    successCount > 0 && failureCount > 0
      ? "mixed-paper-pattern"
      : successCount > 0
        ? "paper-success"
        : failureCount > 0
          ? "paper-failure"
          : "no-paper-execution";
  return {
    schema: "openclaw.trading.fast-order-paper-pattern.v1",
    pattern,
    successCount,
    failureCount,
    latestStatus: stringOr(
      latestPaperExecution?.status ?? latestReview?.status,
      successCount > 0 ? "paper_execution_recorded" : "none",
    ),
    latestSymbol: stringOr(
      latestPaperExecution?.symbol ?? reviewPaper?.symbol ?? intentTicket?.symbol,
      "TX00",
    ),
    latestSide: stringOr(
      latestPaperExecution?.side ?? reviewPaper?.side ?? intentTicket?.side,
      "wait",
    ),
    latestQuantity: numberOr(
      latestPaperExecution?.quantity ?? reviewPaper?.quantity ?? intentTicket?.quantity,
      1,
    ),
    historyTotal: numberOr(history?.total, historyEntries.length),
    historyReturned: numberOr(history?.returned, historyEntries.length),
    brokerCommandEnabled: false,
    sentBrokerOrder: false,
    submissionCommand: "",
    readTargets: asRecord(fastOrderAudit?.readTargets) || {},
  };
}

function buildPaperLoopBlocker({ loopReport = {}, intentLifecycle = {} }) {
  const loopStatus = stringOr(loopReport?.status, "");
  const paperIntentCreated = bool(loopReport?.trading?.paperIntentCreated);
  const activeIntentRecords = numberOr(intentLifecycle?.currentActiveRecordCount, 0);
  const latestEpoch = asRecord(intentLifecycle?.latestEpoch) || {};
  const currentReason =
    stringOr(loopReport?.trading?.reason, "") ||
    stringOr(loopReport?.strategy?.error, "") ||
    stringOr(loopReport?.nextSafeTask, "");
  const noCurrentIntent = !paperIntentCreated && activeIntentRecords === 0;
  const blockerStatus = paperIntentCreated
    ? "paper_intent_created"
    : activeIntentRecords > 0
      ? "strategy_intents_present_loop_blocked"
      : noCurrentIntent
        ? "blocked_no_current_paper_intent"
        : "paper_lifecycle_readable";
  return {
    schema: "openclaw.capital.paper-loop-blocker.v1",
    status: blockerStatus,
    loopStatus,
    readinessStatus: stringOr(loopReport?.readiness?.status, ""),
    strategyStatus: stringOr(loopReport?.strategy?.status, ""),
    paperIntentCreated,
    paperIntentId: stringOr(loopReport?.trading?.paperIntentId, ""),
    activeIntentRecords,
    currentReason,
    nextSafeTask: stringOr(loopReport?.nextSafeTask, ""),
    latestEpochStatus: stringOr(latestEpoch.status, ""),
    latestEpochReason: stringOr(latestEpoch.reason, ""),
    latestEpochPreviousRecordCount: numberOr(latestEpoch.previousRecordCount, 0),
    latestEpochIntentRunId: stringOr(latestEpoch.intentRunId, ""),
    liveOrderAllowed: false,
    sentBrokerOrder: false,
  };
}

function badgeForStatus(status) {
  switch (status) {
    case "blocked_1115":
      return {
        tone: "danger",
        label: "1115 冷卻中",
        title: "類高頻自動交易助手 cooldown active",
        description: "禁止登入、禁止推進 StartIndex，只更新 OpenClaw 狀態。",
      };
    case "blocked_quote_stale":
      return {
        tone: "warning",
        label: "報價過期 STALE",
        title: "類高頻自動交易助手 freshness gate 未通過",
        description: "等待新的 SKQuoteLib quote callback，不要使用舊報價。",
      };
    case "blocked_quote_incomplete":
      return {
        tone: "warning",
        label: "報價未完成",
        title: "類高頻自動交易助手輪替尚未完成",
        description: "只允許執行一個 read-only market-aligned window。",
      };
    case "blocked_quote_guard":
      return {
        tone: "danger",
        label: "報價阻塞 BLOCKED",
        title: "類高頻自動交易助手 guard active",
        description: "先查 guard / 錯誤原因，只更新 OpenClaw 狀態。",
      };
    case "paper_intent_created":
      return {
        tone: "success",
        label: "紙上擬態已產生",
        title: "類高頻自動交易助手 paper intent created",
        description: "已產生 paper intent，維持 paper-only loop，不啟用真實下單。",
      };
    case "paper_promotion_review":
      return {
        tone: "success",
        label: "可進 promotion review",
        title: "類高頻自動交易助手 promotion review ready",
        description: "已達 paper promotion review 門檻，保持 read-only。",
      };
    case "paper_ready":
      return {
        tone: "success",
        label: "類高頻助手就緒",
        title: "類高頻自動交易助手 ready",
        description: "類高頻自動交易助手可持續運行，維持 heartbeat 檢查。",
      };
    default:
      return {
        tone: "neutral",
        label: "類高頻 learning 中",
        title: "類高頻自動交易學習",
        description: "維持 paper-only learning，等待新的 SKQuoteLib quote callback 後再評估。",
      };
  }
}

function determineStatus({ quoteStatus, loopReport, learningSummary, promotionGate, cronCheck }) {
  const quoteState = stringOr(quoteStatus?.status, "degraded");
  if (bool(quoteStatus?.guard?.active) && stringOr(quoteStatus?.guard?.lastCode, "") === "1115") {
    return "blocked_1115";
  }
  if (quoteState === "stale") {
    return "blocked_quote_stale";
  }
  if (quoteState === "incomplete") {
    return "blocked_quote_incomplete";
  }
  if (quoteState === "blocked") {
    return "blocked_quote_guard";
  }
  if (stringOr(loopReport?.status, "") === "paper_intent_created") {
    return "paper_intent_created";
  }
  if (bool(promotionGate?.promoted) || stringOr(learningSummary?.status, "") === "approved_paper") {
    return "paper_promotion_review";
  }
  if (
    quoteStatus?.ready === true &&
    bool(quoteStatus?.monitors?.allReadOnlyMonitorsReady) &&
    stringOr(cronCheck?.status, "") === "passed"
  ) {
    return "paper_ready";
  }
  return "paper_learning";
}

function operatorActionForStatus(status, sources) {
  switch (status) {
    case "blocked_1115":
      return (
        sources.quoteStatus?.nextSafeTask ||
        "等待 guard cooldown 到期；禁止登入與 StartIndex 推進。"
      );
    case "blocked_quote_stale": {
      const blockers = Array.isArray(sources.quoteStatus?.diagnostics?.blockers)
        ? sources.quoteStatus.diagnostics.blockers
        : [];
      const blockerText = blockers.length > 0 ? `（${blockers.join("、")}）` : "";
      return `等待新的 SKQuoteLib quote callback；不要登入、不要推進 StartIndex。${blockerText}`;
    }
    case "blocked_quote_incomplete":
      return sources.quoteStatus?.nextSafeTask || "只執行一個 read-only market-aligned window。";
    case "blocked_quote_guard":
      return sources.quoteStatus?.nextSafeTask || "先查 guard / 錯誤原因，只更新 OpenClaw 狀態。";
    case "paper_intent_created":
      return (
        sources.loopReport?.nextSafeTask ||
        "持續由 heartbeat 重跑 capital-hft:paper-loop；累積 paper learning，不啟用真實下單。"
      );
    case "paper_promotion_review":
      return (
        sources.promotionGate?.recommendation?.nextSafeTask ||
        "進入 paper promotion review，確認可否由人工審查升級。"
      );
    case "paper_ready":
      return sources.quoteStatus?.nextSafeTask || "維持 heartbeat 健康檢查，不重跑全商品。";
    default:
      return (
        sources.learningSummary?.recommendation?.nextSafeTask ||
        sources.quoteStatus?.nextSafeTask ||
        "維持 paper-only learning，等待新的 SKQuoteLib quote callback 後再評估。"
      );
  }
}

function chooseNextSafeTask(status, sources) {
  switch (status) {
    case "blocked_1115":
    case "blocked_quote_stale":
    case "blocked_quote_incomplete":
    case "blocked_quote_guard":
      return (
        sources.quoteStatus?.nextSafeTask ||
        sources.loopReport?.nextSafeTask ||
        "等待新的 SKQuoteLib quote callback，不要登入、不要推進 StartIndex。"
      );
    case "paper_intent_created":
      return (
        sources.loopReport?.nextSafeTask ||
        sources.learningSummary?.recommendation?.nextSafeTask ||
        "持續由 heartbeat 重跑 capital-hft:paper-loop。"
      );
    case "paper_promotion_review":
      return (
        sources.promotionGate?.recommendation?.nextSafeTask ||
        sources.learningSummary?.recommendation?.nextSafeTask ||
        "進入 paper promotion review。"
      );
    case "paper_ready":
      return sources.quoteStatus?.nextSafeTask || "維持 heartbeat 健康檢查，不重跑全商品。";
    default:
      return (
        sources.learningSummary?.recommendation?.nextSafeTask ||
        sources.quoteStatus?.nextSafeTask ||
        "維持 paper-only learning，等待新的 SKQuoteLib quote callback 後再評估。"
      );
  }
}

function buildControlSummary({
  quoteStatus,
  loopReport,
  learningSummary,
  promotionGate,
  cronCheck,
  tickDiagnostic,
  chartStrategy,
  fastOrderPaperPattern,
  intentLifecycle,
  paperLoopBlocker,
  status,
  ready,
}) {
  return {
    quoteStatus: stringOr(quoteStatus?.status, ""),
    loopStatus: stringOr(loopReport?.status, ""),
    learningStatus: stringOr(learningSummary?.status, ""),
    promotionStatus: stringOr(promotionGate?.status, ""),
    cronStatus: stringOr(cronCheck?.status, ""),
    quoteFreshnessStatus: stringOr(quoteStatus?.quoteProof?.freshnessStatus, ""),
    quoteAgeSeconds: numberOr(quoteStatus?.quoteProof?.freshnessAgeSeconds, -1),
    latestStock: stringOr(quoteStatus?.quoteProof?.latestStock, ""),
    nextStartIndex: numberOr(quoteStatus?.completion?.nextStartIndex, 0),
    paperIntents: numberOr(
      learningSummary?.summary?.paperIntents ?? loopReport?.learning?.counters?.paperIntents,
      0,
    ),
    consecutiveReadyCycles: numberOr(learningSummary?.summary?.consecutiveReadyCycles, 0),
    consecutiveReadinessBlocks: numberOr(learningSummary?.summary?.consecutiveReadinessBlocks, 0),
    paperEligible: bool(learningSummary?.paperEligible),
    promoted: bool(promotionGate?.promoted),
    allReadOnlyMonitorsReady: bool(quoteStatus?.monitors?.allReadOnlyMonitorsReady),
    quoteReady: bool(quoteStatus?.ready),
    cronDue: bool(cronCheck?.summary?.due),
    tickStatus: stringOr(tickDiagnostic?.status, ""),
    tickMonitorRunning: bool(tickDiagnostic?.tick?.monitorRunning),
    tickRealtimeRunning: bool(tickDiagnostic?.tick?.realtimeRunning),
    assistantReady: ready,
    assistantStatus: status,
    chartStrategyStatus: stringOr(chartStrategy?.status, ""),
    chartDataReady: bool(chartStrategy?.chartData?.ready),
    strategyBookReady: bool(chartStrategy?.strategyBook?.ready),
    strategyCount: numberOr(chartStrategy?.strategyBook?.strategyCount, 0),
    enabledStrategyCount: numberOr(chartStrategy?.strategyBook?.enabledStrategyCount, 0),
    fastOrderPaperPattern: stringOr(fastOrderPaperPattern?.pattern, "no-paper-execution"),
    fastOrderPaperSuccessCount: numberOr(fastOrderPaperPattern?.successCount, 0),
    fastOrderPaperFailureCount: numberOr(fastOrderPaperPattern?.failureCount, 0),
    latestFastOrderStatus: stringOr(fastOrderPaperPattern?.latestStatus, "none"),
    activeIntentRecords: numberOr(intentLifecycle?.currentActiveRecordCount, 0),
    intentLifecycleStatus: stringOr(intentLifecycle?.status, ""),
    latestIntentEpochStatus: stringOr(intentLifecycle?.latestEpoch?.status, ""),
    latestIntentEpochReason: stringOr(intentLifecycle?.latestEpoch?.reason, ""),
    latestIntentEpochPreviousRecordCount: numberOr(
      intentLifecycle?.latestEpoch?.previousRecordCount,
      0,
    ),
    currentBlockerStatus: stringOr(paperLoopBlocker?.status, ""),
    currentBlockerReason: stringOr(paperLoopBlocker?.currentReason, ""),
    entrySide: stringOr(learningSummary?.execution?.entry?.side, ""),
    exitSide: stringOr(learningSummary?.execution?.exit?.side, ""),
    entryAction: stringOr(learningSummary?.execution?.entry?.action, ""),
    exitAction: stringOr(learningSummary?.execution?.exit?.action, ""),
  };
}

function buildChartStrategyState({
  strategyBook = {},
  chartBars = [],
  fastOrderPaperPattern = {},
}) {
  const availableBarFiles = Array.isArray(chartBars)
    ? chartBars.filter((item) => item?.exists === true && numberOr(item?.sizeBytes, 0) > 0)
    : [];
  const strategies = Array.isArray(strategyBook?.strategies) ? strategyBook.strategies : [];
  const strategyCount = numberOr(strategyBook?.summary?.strategyCount, strategies.length);
  const enabledStrategyCount = numberOr(
    strategyBook?.summary?.enabledStrategyCount,
    strategies.filter((item) => item?.enabled === true).length,
  );
  const strategyBookReady =
    strategyBook?.ready === true &&
    stringOr(strategyBook?.status, "") === "pass" &&
    enabledStrategyCount > 0;
  const chartDataReady = availableBarFiles.length > 0;
  const paperSimulationStatus = stringOr(strategyBook?.simulation?.status, "");
  const realQuoteVerified = bool(strategyBook?.simulation?.realQuoteVerified);
  const brokerWriteLocked =
    !bool(strategyBook?.safety?.sentOrder) &&
    !bool(strategyBook?.safety?.wroteBroker) &&
    !bool(strategyBook?.safety?.postedCommand);
  const ready = strategyBookReady && chartDataReady && brokerWriteLocked;
  const status = ready
    ? realQuoteVerified
      ? "ready_real_quote_verified"
      : "ready_waiting_fresh_quote"
    : strategyBookReady || chartDataReady
      ? "partial"
      : "missing";

  return {
    schema: "openclaw.capital.chart-strategy-state.v1",
    status,
    ready,
    chartData: {
      ready: chartDataReady,
      availableFiles: availableBarFiles.length,
      candidates: Array.isArray(chartBars) ? chartBars : [],
    },
    strategyBook: {
      ready: strategyBookReady,
      status: stringOr(strategyBook?.status, ""),
      generatedAt: stringOr(strategyBook?.generatedAt, ""),
      strategyCount,
      enabledStrategyCount,
      disabledStrategyCount: numberOr(strategyBook?.summary?.disabledStrategyCount, 0),
      strategies: strategies
        .filter((item) => item?.enabled === true)
        .slice(0, 12)
        .map((item) => ({
          name: stringOr(item?.name, ""),
          weight: numberOr(item?.weight, 0),
          paramKeys: Array.isArray(item?.paramKeys) ? item.paramKeys : [],
        })),
    },
    simulation: {
      status: paperSimulationStatus,
      mode: stringOr(strategyBook?.simulation?.mode, ""),
      symbolsSimulated: numberOr(strategyBook?.simulation?.symbolsSimulated, 0),
      paperIntentCount: numberOr(strategyBook?.simulation?.paperIntentCount, 0),
      realQuoteVerified,
      realQuoteBlockerCode: stringOr(strategyBook?.simulation?.realQuoteBlockerCode, ""),
    },
    safety: {
      paperOnly: true,
      liveOrderAllowed: false,
      brokerWriteLocked,
      sentOrder: bool(strategyBook?.safety?.sentOrder),
      wroteBroker: bool(strategyBook?.safety?.wroteBroker),
      postedCommand: bool(strategyBook?.safety?.postedCommand),
      livePromotionRequired: bool(strategyBook?.safety?.livePromotionRequired),
    },
    fastOrderPaperPattern,
    strategySummary: {
      fastOrderPaperPattern: stringOr(fastOrderPaperPattern?.pattern, "no-paper-execution"),
      paperSuccessCount: numberOr(fastOrderPaperPattern?.successCount, 0),
      paperFailureCount: numberOr(fastOrderPaperPattern?.failureCount, 0),
      latestFastOrderStatus: stringOr(fastOrderPaperPattern?.latestStatus, "none"),
      brokerCommandEnabled: false,
      sentBrokerOrder: false,
      submissionCommand: "",
    },
    nextSafeTask:
      stringOr(strategyBook?.nextSafeTask, "") ||
      "先產生 OpenClaw-readable strategy book 與 K 棒資料，再接回 paper-only assistant state。",
  };
}

function buildFlowGate(id, status, reason, evidence = {}) {
  return {
    id,
    status,
    reason,
    evidence,
  };
}

function buildFlowDecision({
  quoteStatus,
  loopReport,
  learningSummary,
  promotionGate,
  cronCheck,
  tickDiagnostic,
  chartStrategy,
  fastOrderPaperPattern,
  intentLifecycle,
  paperLoopBlocker,
  status,
  ready,
  nextSafeTask,
}) {
  const quoteBlockers = Array.isArray(quoteStatus?.diagnostics?.blockers)
    ? quoteStatus.diagnostics.blockers
    : [];
  const quoteFresh =
    quoteStatus?.ready === true &&
    bool(quoteStatus?.monitors?.allReadOnlyMonitorsReady) &&
    stringOr(quoteStatus?.quoteProof?.freshnessStatus, "") === "fresh" &&
    bool(quoteStatus?.diagnostics?.bidAskUsable);
  const latestStock = stringOr(quoteStatus?.quoteProof?.latestStock, "");
  const strategyLearningStatus = stringOr(learningSummary?.status, "unknown");
  const paperIntentCreated =
    bool(loopReport?.trading?.paperIntentCreated) ||
    bool(learningSummary?.execution?.paperIntentCreated);
  const activeIntentRecords = numberOr(intentLifecycle?.currentActiveRecordCount, 0);
  const latestEpoch = asRecord(intentLifecycle?.latestEpoch) || {};
  const liveEligible = bool(learningSummary?.liveEligible);
  const promoted = bool(promotionGate?.promoted);
  const paperSafetyLocked =
    bool(quoteStatus?.readOnly) &&
    !bool(quoteStatus?.loginAttempted) &&
    !bool(quoteStatus?.liveTradingEnabled) &&
    !bool(quoteStatus?.writeTradingEnabled) &&
    !bool(loopReport?.liveTradingEnabled) &&
    !bool(loopReport?.writeTradingEnabled) &&
    !bool(loopReport?.brokerOrderPathEnabled);

  const gates = [
    buildFlowGate(
      "quote_freshness",
      quoteFresh ? "pass" : "blocked",
      quoteFresh
        ? "fresh matched quote with usable bid/ask"
        : "stale, unmatched, or unusable quote blocks order intent",
      {
        quoteStatus: stringOr(quoteStatus?.status, ""),
        freshnessStatus: stringOr(quoteStatus?.quoteProof?.freshnessStatus, ""),
        freshnessAgeSeconds: numberOr(quoteStatus?.quoteProof?.freshnessAgeSeconds, -1),
        bidAskUsable: bool(quoteStatus?.diagnostics?.bidAskUsable),
        blockers: quoteBlockers,
      },
    ),
    buildFlowGate(
      "symbol_routing",
      latestStock ? "pass" : "blocked",
      latestStock
        ? "semantic target is resolved to the latest reportable quote symbol"
        : "no matched orderable/reportable symbol is available",
      {
        latestStock,
        latestStockName: stringOr(quoteStatus?.quoteProof?.latestStockName, ""),
        nextStartIndex: numberOr(quoteStatus?.completion?.nextStartIndex, 0),
      },
    ),
    buildFlowGate(
      "chart_strategy",
      chartStrategy?.ready === true
        ? "pass"
        : chartStrategy?.chartData?.ready === true || chartStrategy?.strategyBook?.ready === true
          ? "warn"
          : "blocked",
      chartStrategy?.ready === true
        ? "chart bars and strategy book are OpenClaw-readable with broker writes locked"
        : chartStrategy?.chartData?.ready === true || chartStrategy?.strategyBook?.ready === true
          ? "chart or strategy evidence is partial; keep paper-only"
          : "chart bars and strategy book are missing",
      {
        status: stringOr(chartStrategy?.status, ""),
        chartDataReady: bool(chartStrategy?.chartData?.ready),
        strategyBookReady: bool(chartStrategy?.strategyBook?.ready),
        strategyCount: numberOr(chartStrategy?.strategyBook?.strategyCount, 0),
        enabledStrategyCount: numberOr(chartStrategy?.strategyBook?.enabledStrategyCount, 0),
        realQuoteVerified: bool(chartStrategy?.simulation?.realQuoteVerified),
        brokerWriteLocked: bool(chartStrategy?.safety?.brokerWriteLocked),
      },
    ),
    buildFlowGate(
      "strategy_learning",
      learningSummary?.paperEligible === true || strategyLearningStatus === "approved_paper"
        ? "pass"
        : strategyLearningStatus === "blocked"
          ? "blocked"
          : "warn",
      learningSummary?.paperEligible === true || strategyLearningStatus === "approved_paper"
        ? "strategy has paper approval evidence"
        : strategyLearningStatus === "blocked"
          ? "strategy learning registry blocks this strategy"
          : "strategy remains candidate; paper learning can continue, live cannot",
      {
        status: strategyLearningStatus,
        paperEligible: bool(learningSummary?.paperEligible),
        liveEligible,
        consecutiveReadyCycles: numberOr(learningSummary?.summary?.consecutiveReadyCycles, 0),
        paperIntents: numberOr(learningSummary?.summary?.paperIntents, 0),
      },
    ),
    buildFlowGate(
      "fast_order_paper_pattern",
      stringOr(fastOrderPaperPattern?.pattern, "no-paper-execution") === "no-paper-execution"
        ? "warn"
        : "pass",
      "fast-order paper audit pattern is summarized from Telegram paper review history only",
      {
        pattern: stringOr(fastOrderPaperPattern?.pattern, "no-paper-execution"),
        successCount: numberOr(fastOrderPaperPattern?.successCount, 0),
        failureCount: numberOr(fastOrderPaperPattern?.failureCount, 0),
        latestStatus: stringOr(fastOrderPaperPattern?.latestStatus, "none"),
        brokerCommandEnabled: false,
        sentBrokerOrder: false,
        submissionCommand: "",
      },
    ),
    buildFlowGate(
      "hft_truth_level",
      "warn",
      "tick/best5 paper simulation is useful but not precise L2/L3 queue-position HFT",
      {
        hftLikeAutomation: true,
        limitation: "limited_microstructure_data",
        tickStatus: stringOr(tickDiagnostic?.status, ""),
        tickRealtimeRunning: bool(tickDiagnostic?.tick?.realtimeRunning),
      },
    ),
    buildFlowGate(
      "order_lifecycle",
      paperIntentCreated
        ? "pass"
        : activeIntentRecords > 0 || latestEpoch.status
          ? "warn"
          : "blocked",
      paperIntentCreated
        ? "paper order intent exists and remains in the paper lifecycle"
        : activeIntentRecords > 0
          ? "strategy intents exist, but paper-loop is still blocked and has not promoted a current trading paper intent"
          : latestEpoch.status
            ? "no active paper intent exists, but the last cleared epoch is exposed for UI evidence"
            : "paper lifecycle state is readable but no current paper intent or epoch evidence exists",
      {
        loopStatus: stringOr(loopReport?.status, ""),
        paperIntentCreated,
        paperIntentId: stringOr(loopReport?.trading?.paperIntentId, ""),
        activeIntentRecords,
        lifecycleStatus: stringOr(intentLifecycle?.status, ""),
        latestEpochStatus: stringOr(latestEpoch.status, ""),
        latestEpochReason: stringOr(latestEpoch.reason, ""),
        latestEpochPreviousRecordCount: numberOr(latestEpoch.previousRecordCount, 0),
        currentBlockerStatus: stringOr(paperLoopBlocker?.status, ""),
        currentBlockerReason: stringOr(paperLoopBlocker?.currentReason, ""),
        cronStatus: stringOr(cronCheck?.status, ""),
      },
    ),
    buildFlowGate(
      "pre_trade_risk_gate",
      paperSafetyLocked ? "pass" : "blocked",
      paperSafetyLocked
        ? "paper surface keeps broker login, write trading, and live trading disabled"
        : "risk flags are not paper-safe; block execution",
      {
        quoteReadOnly: bool(quoteStatus?.readOnly),
        quoteLoginAttempted: bool(quoteStatus?.loginAttempted),
        loopLiveTradingEnabled: bool(loopReport?.liveTradingEnabled),
        loopWriteTradingEnabled: bool(loopReport?.writeTradingEnabled),
        brokerOrderPathEnabled: bool(loopReport?.brokerOrderPathEnabled),
      },
    ),
    buildFlowGate(
      "live_promotion",
      "blocked",
      promoted && liveEligible
        ? "paper assistant is not a live execution surface; use the separate live approval gate"
        : "live trading remains disabled until SEMI approval, promotion, canary, rollback, and audit pass",
      {
        promoted,
        liveEligible,
        liveOrderAllowed: false,
      },
    ),
  ];

  let decisionCode = "continue_paper_learning";
  let action = "continue_learning_snapshot";
  let nextCommand = "pnpm capital-hft:auto-trading-learning-snapshot";
  if (status === "blocked_quote_stale" || status === "blocked_quote_incomplete") {
    decisionCode = "wait_for_quote_callback";
    action = "wait_for_fresh_quote";
    nextCommand = "pnpm capital-hft:quote:status";
  } else if (status === "blocked_1115" || status === "blocked_quote_guard") {
    decisionCode = "hold_guarded";
    action = "inspect_quote_guard";
    nextCommand = "pnpm capital-hft:quote:status:check";
  } else if (status === "paper_intent_created") {
    decisionCode = "continue_paper_learning";
    action = "rerun_paper_loop_on_next_fresh_tick";
    nextCommand = "pnpm capital-hft:paper-loop";
  } else if (status === "paper_promotion_review") {
    decisionCode = "review_paper_promotion";
    action = "run_paper_promotion_gate";
    nextCommand = "pnpm capital-hft:paper-hft:promotion:check";
  } else if (status === "paper_ready") {
    decisionCode = "run_next_paper_cycle";
    action = "run_paper_loop";
    nextCommand = "pnpm capital-hft:paper-loop";
  }

  return {
    schema: "openclaw.capital.paper-assistant-flow-decision.v1",
    matrixVersion: "openclaw.auto-trading-fast-flow.v1",
    decisionCode,
    action,
    readyForPaperCycle: ready && paperSafetyLocked && quoteFresh,
    liveOrderAllowed: false,
    liveOrderReason:
      "paper assistant state never submits live orders; live requires separate SEMI approval, promotion gate, canary, rollback, and audit evidence",
    nextCommand,
    nextSafeTask,
    gates,
    researchBasis: [
      "docs/automation/openclaw-auto-trading-assistant-fast-flow-learning.md",
      "docs/automation/capital-api-application-research-2026-05-21.md",
    ],
  };
}

export function buildCapitalPaperAssistantState({
  quoteStatus = {},
  loopReport = {},
  learningSummary = {},
  promotionGate = {},
  cronCheck = {},
  tickDiagnostic = {},
  strategyBook = {},
  chartBars = [],
  fastOrderAudit = {},
  intentLifecycle = {},
  files = {},
}) {
  const fastOrderPaperPattern = buildFastOrderPaperPattern(fastOrderAudit);
  const status = determineStatus({
    quoteStatus,
    loopReport,
    learningSummary,
    promotionGate,
    cronCheck,
    tickDiagnostic,
  });
  const chartStrategy = buildChartStrategyState({
    strategyBook,
    chartBars,
    fastOrderPaperPattern,
  });
  const paperLoopBlocker = buildPaperLoopBlocker({
    loopReport,
    intentLifecycle,
  });
  const badge = badgeForStatus(status);
  const ready =
    quoteStatus?.ready === true &&
    bool(quoteStatus?.monitors?.allReadOnlyMonitorsReady) &&
    stringOr(cronCheck?.status, "") === "passed";
  const nextSafeTask = chooseNextSafeTask(status, {
    quoteStatus,
    loopReport,
    learningSummary,
    promotionGate,
    cronCheck,
    tickDiagnostic,
  });
  const flowDecision = buildFlowDecision({
    quoteStatus,
    loopReport,
    learningSummary,
    promotionGate,
    cronCheck,
    tickDiagnostic,
    chartStrategy,
    fastOrderPaperPattern,
    intentLifecycle,
    paperLoopBlocker,
    status,
    ready,
    nextSafeTask,
  });

  return {
    schema: "openclaw.capital.paper-assistant-state.v1",
    generatedAt: new Date().toISOString(),
    provider: "capital",
    mode: "paper",
    readOnlyQuoteOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    hftLikeAutomation: true,
    status,
    ready,
    badge,
    assistant: {
      name: "類高頻自動交易助手",
      title: badge.title,
      description: badge.description,
      operatorAction: operatorActionForStatus(status, {
        quoteStatus,
        loopReport,
        learningSummary,
        promotionGate,
        cronCheck,
      }),
      entrypoints: [
        "pnpm capital-hft:auto-trading",
        "pnpm capital-hft:auto-trading-loop",
        "pnpm capital-hft:auto-trading-watch",
        "pnpm capital-hft:auto-trading-watch:daemon",
        "pnpm capital-hft:auto-trading-watch:daemon-check",
        "pnpm capital-hft:auto-trading-watch:startup-install",
        "pnpm capital-hft:auto-trading-watch:startup-check",
      ],
    },
    execution: {
      status: stringOr(learningSummary?.execution?.status, ""),
      signalPolicy: stringOr(learningSummary?.execution?.signalPolicy, ""),
      entry: {
        side: stringOr(learningSummary?.execution?.entry?.side, ""),
        style: stringOr(learningSummary?.execution?.entry?.style, ""),
        trigger: stringOr(learningSummary?.execution?.entry?.trigger, ""),
        referencePrice: stringOr(learningSummary?.execution?.entry?.referencePrice, ""),
        action: stringOr(learningSummary?.execution?.entry?.action, ""),
        price: numberOr(learningSummary?.execution?.entry?.price, -1),
        ready: bool(learningSummary?.execution?.entry?.ready),
      },
      exit: {
        side: stringOr(learningSummary?.execution?.exit?.side, ""),
        style: stringOr(learningSummary?.execution?.exit?.style, ""),
        trigger: stringOr(learningSummary?.execution?.exit?.trigger, ""),
        referencePrice: stringOr(learningSummary?.execution?.exit?.referencePrice, ""),
        action: stringOr(learningSummary?.execution?.exit?.action, ""),
        price: numberOr(learningSummary?.execution?.exit?.price, -1),
        ready: bool(learningSummary?.execution?.exit?.ready),
      },
      actionSummary: stringOr(learningSummary?.execution?.actionSummary, ""),
      paperIntentCreated: bool(learningSummary?.execution?.paperIntentCreated),
    },
    chartStrategy,
    flowDecision,
    fastOrderPaperPattern,
    intentLifecycle,
    paperLoopBlocker,
    summary: buildControlSummary({
      quoteStatus,
      loopReport,
      learningSummary,
      promotionGate,
      cronCheck,
      tickDiagnostic,
      chartStrategy,
      fastOrderPaperPattern,
      intentLifecycle,
      paperLoopBlocker,
      status,
      ready,
    }),
    quote: {
      status: stringOr(quoteStatus?.status, ""),
      ready: bool(quoteStatus?.ready),
      freshnessStatus: stringOr(quoteStatus?.quoteProof?.freshnessStatus, ""),
      freshnessAgeSeconds: numberOr(quoteStatus?.quoteProof?.freshnessAgeSeconds, -1),
      latestStock: stringOr(quoteStatus?.quoteProof?.latestStock, ""),
      latestStockName: stringOr(quoteStatus?.quoteProof?.latestStockName, ""),
      allReadOnlyMonitorsReady: bool(quoteStatus?.monitors?.allReadOnlyMonitorsReady),
      nextStartIndex: numberOr(quoteStatus?.completion?.nextStartIndex, 0),
      guardActive: bool(quoteStatus?.guard?.active),
      guardCode: stringOr(quoteStatus?.guard?.lastCode, ""),
      diagnostics: {
        bidAskUsable: bool(quoteStatus?.diagnostics?.bidAskUsable),
        blockers: Array.isArray(quoteStatus?.diagnostics?.blockers)
          ? quoteStatus.diagnostics.blockers
          : [],
        latestQuote: quoteStatus?.diagnostics?.latestQuote ?? {},
      },
    },
    loop: {
      status: stringOr(loopReport?.status, ""),
      ready: bool(loopReport?.readiness?.ready),
      paperIntentCreated: bool(loopReport?.trading?.paperIntentCreated),
      paperIntentId: stringOr(loopReport?.trading?.paperIntentId, ""),
      currentBlocker: paperLoopBlocker,
      nextSafeTask: stringOr(loopReport?.nextSafeTask, ""),
    },
    learning: {
      status: stringOr(learningSummary?.status, ""),
      paperEligible: bool(learningSummary?.paperEligible),
      liveEligible: bool(learningSummary?.liveEligible),
      consecutiveReadyCycles: numberOr(learningSummary?.summary?.consecutiveReadyCycles, 0),
      consecutiveReadinessBlocks: numberOr(learningSummary?.summary?.consecutiveReadinessBlocks, 0),
      fastOrderPaperPattern,
      nextSafeTask: stringOr(learningSummary?.recommendation?.nextSafeTask, ""),
    },
    promotion: {
      status: stringOr(promotionGate?.status, ""),
      promoted: bool(promotionGate?.promoted),
      nextSafeTask: stringOr(promotionGate?.recommendation?.nextSafeTask, ""),
    },
    cron: {
      status: stringOr(cronCheck?.status, ""),
      enabled: bool(cronCheck?.summary?.enabled),
      due: bool(cronCheck?.summary?.due),
      lastRunStatus: stringOr(cronCheck?.summary?.lastRunStatus, ""),
      nextSafeTask: stringOr(cronCheck?.nextSafeTask, ""),
    },
    tick: {
      status: stringOr(tickDiagnostic?.status, ""),
      monitorRunning: bool(tickDiagnostic?.tick?.monitorRunning),
      realtimeRunning: bool(tickDiagnostic?.tick?.realtimeRunning),
      latestCallbackAt: stringOr(tickDiagnostic?.latestCallback?.receivedAt, ""),
      latestCallbackSource: stringOr(tickDiagnostic?.latestCallback?.eventSource, ""),
      latestCallbackBid: stringOr(tickDiagnostic?.latestCallback?.bid, ""),
      latestCallbackAsk: stringOr(tickDiagnostic?.latestCallback?.ask, ""),
      nextSafeTask: stringOr(tickDiagnostic?.recommendation?.nextSafeTask, ""),
    },
    recommendation: {
      nextSafeTask,
    },
    files: {
      quoteStatusPath: stringOr(files.quoteStatusPath, ""),
      loopReportPath: stringOr(files.loopReportPath, ""),
      learningSummaryPath: stringOr(files.learningSummaryPath, ""),
      promotionGatePath: stringOr(files.promotionGatePath, ""),
      cronCheckPath: stringOr(files.cronCheckPath, ""),
      tickDiagnosticPath: stringOr(files.tickDiagnosticPath, ""),
      strategyBookPath: stringOr(files.strategyBookPath, ""),
      fastOrderAuditPaths: asRecord(files.fastOrderAuditPaths) || {},
      chartBarPaths: Array.isArray(files.chartBarPaths) ? files.chartBarPaths : [],
      intentLifecyclePaths: asRecord(files.intentLifecyclePaths) || {},
      startupStatePath: stringOr(files.startupStatePath, ""),
      serviceStatePath: stringOr(files.serviceStatePath, ""),
      reportPath: stringOr(files.reportPath, ""),
    },
  };
}

export async function writeCapitalPaperAssistantState(report, reportPath) {
  await writeJsonWithSha(reportPath, report);
}

export async function readCapitalPaperAssistantState(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const quoteStatusPath = path.resolve(options.quoteStatusPath || defaultQuoteStatusPath(repoRoot));
  const loopReportPath = path.resolve(options.loopReportPath || defaultLoopReportPath(repoRoot));
  const learningSummaryPath = path.resolve(
    options.learningSummaryPath || defaultLearningSummaryPath(repoRoot),
  );
  const promotionGatePath = path.resolve(
    options.promotionGatePath || defaultPromotionGatePath(repoRoot),
  );
  const cronCheckPath = path.resolve(options.cronCheckPath || defaultCronCheckPath(repoRoot));
  const tickDiagnosticPath = path.resolve(
    options.tickDiagnosticPath || defaultTickDiagnosticPath(repoRoot),
  );
  const strategyBookPaths = Array.isArray(options.strategyBookPaths)
    ? options.strategyBookPaths.map((item) => path.resolve(item))
    : defaultStrategyBookPaths(repoRoot);
  const chartBarPaths = Array.isArray(options.chartBarPaths)
    ? options.chartBarPaths.map((item) => path.resolve(item))
    : defaultChartBarPaths(repoRoot);
  const startupStatePath = path.resolve(
    options.startupStatePath || defaultStartupStatePath(repoRoot),
  );
  const serviceStatePath = path.resolve(
    options.serviceStatePath || defaultServiceStatePath(repoRoot),
  );
  const reportPath = path.resolve(options.reportPath || defaultOutputPath(repoRoot));
  const fastOrderAuditPaths = defaultFastOrderAuditPaths(repoRoot);
  const intentLifecyclePaths = defaultPaperIntentLifecyclePaths(repoRoot);

  const [
    quoteStatus,
    loopReport,
    learningSummary,
    promotionGate,
    cronCheck,
    tickDiagnostic,
    strategyBookResult,
    chartBars,
    fastOrderAudit,
    intentLifecycle,
  ] = await Promise.all([
    readJson(quoteStatusPath, "Capital quote status"),
    readJson(loopReportPath, "Capital paper automation loop"),
    readJson(learningSummaryPath, "Capital paper learning summary"),
    readOptionalJson(promotionGatePath, {}),
    readOptionalJson(cronCheckPath, {}),
    readOptionalJson(tickDiagnosticPath, {}),
    readFirstOptionalJson(strategyBookPaths, {}),
    readChartBarSummaries(chartBarPaths),
    readFastOrderAuditState(repoRoot),
    readPaperIntentLifecycleState(repoRoot, intentLifecyclePaths),
  ]);

  const report = buildCapitalPaperAssistantState({
    quoteStatus,
    loopReport,
    learningSummary,
    promotionGate,
    cronCheck,
    tickDiagnostic,
    strategyBook: strategyBookResult.value,
    chartBars,
    fastOrderAudit,
    intentLifecycle,
    files: {
      quoteStatusPath,
      loopReportPath,
      learningSummaryPath,
      promotionGatePath,
      cronCheckPath,
      tickDiagnosticPath,
      strategyBookPath: strategyBookResult.filePath,
      fastOrderAuditPaths,
      chartBarPaths,
      intentLifecyclePaths,
      startupStatePath,
      serviceStatePath,
      reportPath,
    },
  });

  return {
    report,
    files: {
      quoteStatusPath,
      loopReportPath,
      learningSummaryPath,
      promotionGatePath,
      cronCheckPath,
      tickDiagnosticPath,
      strategyBookPath: strategyBookResult.filePath,
      chartBarPaths,
      intentLifecyclePaths,
      startupStatePath,
      serviceStatePath,
      reportPath,
    },
  };
}

export async function runCapitalPaperAssistantState(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const reportPath = path.resolve(options.reportPath || defaultOutputPath(repoRoot));
  const result = await readCapitalPaperAssistantState({
    ...options,
    repoRoot,
    reportPath,
  });
  if (options.writeState) {
    await writeCapitalPaperAssistantState(result.report, reportPath);
  }
  if (!options.silent) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          "OpenClaw 類高頻自動交易助手 state",
          `status=${result.report.status}`,
          `ready=${result.report.ready}`,
          `badge=${result.report.badge.label}`,
          `nextSafeTask=${result.report.recommendation.nextSafeTask}`,
          options.writeState ? `report=${reportPath}` : "",
        ]
          .filter(Boolean)
          .join("\n") + "\n",
      );
    }
  }
  return result;
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    quoteStatusPath: "",
    loopReportPath: "",
    learningSummaryPath: "",
    promotionGatePath: "",
    cronCheckPath: "",
    reportPath: "",
    json: false,
    writeState: false,
    silent: false,
    requireReady: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--quote-status") {
      options.quoteStatusPath = argv[++index] ?? options.quoteStatusPath;
    } else if (arg.startsWith("--quote-status=")) {
      options.quoteStatusPath = arg.slice("--quote-status=".length);
    } else if (arg === "--loop-report") {
      options.loopReportPath = argv[++index] ?? options.loopReportPath;
    } else if (arg.startsWith("--loop-report=")) {
      options.loopReportPath = arg.slice("--loop-report=".length);
    } else if (arg === "--learning-summary") {
      options.learningSummaryPath = argv[++index] ?? options.learningSummaryPath;
    } else if (arg.startsWith("--learning-summary=")) {
      options.learningSummaryPath = arg.slice("--learning-summary=".length);
    } else if (arg === "--promotion-gate") {
      options.promotionGatePath = argv[++index] ?? options.promotionGatePath;
    } else if (arg.startsWith("--promotion-gate=")) {
      options.promotionGatePath = arg.slice("--promotion-gate=".length);
    } else if (arg === "--cron-check") {
      options.cronCheckPath = argv[++index] ?? options.cronCheckPath;
    } else if (arg.startsWith("--cron-check=")) {
      options.cronCheckPath = arg.slice("--cron-check=".length);
    } else if (arg === "--report") {
      options.reportPath = argv[++index] ?? options.reportPath;
    } else if (arg.startsWith("--report=")) {
      options.reportPath = arg.slice("--report=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--silent") {
      options.silent = true;
    } else if (arg === "--require-ready") {
      options.requireReady = true;
    }
  }
  return options;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  runCapitalPaperAssistantState(options)
    .then(({ report }) => {
      if (options.requireReady && !report.ready) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      process.stderr.write(
        `capital 類高頻自動交易助手 state failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exitCode = 1;
    });
}
