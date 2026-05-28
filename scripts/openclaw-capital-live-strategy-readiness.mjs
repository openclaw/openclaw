import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalLiveTradingPromotionGate } from "./openclaw-capital-live-trading-promotion-gate.mjs";
import { runCapitalPaperStrategyEvaluator } from "./openclaw-capital-paper-strategy-evaluator.mjs";
import { readCapitalServiceStatus } from "./openclaw-capital-service-status.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_CAPITAL_ROOT = "D:\\群益及元大API\\CapitalHftService";
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-strategy-readiness-latest.json",
);
const DEFAULT_LIVE_ORDER_DRY_RUN_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-order-dry-run-pretrade-gate-latest.json",
);
const DEFAULT_TELEGRAM_SEMI_APPROVAL_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-telegram-semi-approval-gate-latest.json",
);
const DEFAULT_TELEGRAM_SEMI_CALLBACK_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-telegram-semi-approval-callback-latest.json",
);
const DEFAULT_LATENCY_GAP_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-latency-gap-instrumentation-latest.json",
);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    return {
      __missing: true,
      __error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeJsonWithSha(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

function parseDateMs(value) {
  if (typeof value !== "string" || value.trim() === "" || value === "N/A") {
    return Number.NaN;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function ageMs(now, value) {
  const parsed = parseDateMs(value);
  return Number.isFinite(parsed) ? Math.max(0, now.getTime() - parsed) : null;
}

function check(id, ok, message, evidence = {}) {
  return {
    id,
    status: ok ? "pass" : "fail",
    message,
    evidence,
  };
}

function failedIds(checks) {
  return checks.filter((item) => item.status !== "pass").map((item) => item.id);
}

export function isCapitalLivePromotionManualReviewOnly(report) {
  return (
    report?.schema === "openclaw.capital.live-trading-promotion-gate.v1" &&
    report?.liveTradingEnabled === false &&
    report?.writeTradingEnabled === false &&
    report?.sentOrder === false &&
    (report?.status === "blocked" ||
      (report?.status === "live_ready" &&
        report?.readyForManualReview === true &&
        report?.blockerCode === "LIVE_TRADING_MANUAL_REVIEW_REQUIRED"))
  );
}

function isOperationalServiceReadinessCheck(check) {
  return check.id !== "service:live-write-disabled";
}

export async function runCapitalLiveStrategyReadiness(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const capitalRoot = path.resolve(options.capitalRoot || DEFAULT_CAPITAL_ROOT);
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH);
  const hftStatusPath = path.join(capitalRoot, "hft_service_status.json");
  const callbackReadbackPath = path.join(
    capitalRoot,
    "state",
    "capital_callback_readback_latest.json",
  );

  const [
    hftStatus,
    callbackReadback,
    liveGateResult,
    paperEvaluation,
    liveOrderDryRunPretrade,
    telegramSemiApproval,
    telegramSemiCallback,
    latencyGapInstrumentation,
    serviceStatus,
  ] = await Promise.all([
    readJsonOptional(hftStatusPath),
    readJsonOptional(callbackReadbackPath),
    runCapitalLiveTradingPromotionGate({ writeState: options.writeState === true }),
    runCapitalPaperStrategyEvaluator({ repoRoot }),
    readJsonOptional(DEFAULT_LIVE_ORDER_DRY_RUN_PATH),
    readJsonOptional(DEFAULT_TELEGRAM_SEMI_APPROVAL_PATH),
    readJsonOptional(DEFAULT_TELEGRAM_SEMI_CALLBACK_PATH),
    readJsonOptional(DEFAULT_LATENCY_GAP_PATH),
    readCapitalServiceStatus({ repoRoot, capitalRoot, now }).catch((error) => ({
      __missing: true,
      __error: error instanceof Error ? error.message : String(error),
    })),
  ]);

  const domesticQuoteAgeMs = ageMs(now, hftStatus.quoteStats?.lastQuoteAt);
  const overseasQuoteAgeMs = ageMs(now, hftStatus.osQuoteStats?.lastQuoteAt);
  const domesticFreshByCallback = domesticQuoteAgeMs !== null && domesticQuoteAgeMs <= 120_000;
  const overseasFreshByCallback = overseasQuoteAgeMs !== null && overseasQuoteAgeMs <= 120_000;
  const quoteSessionClosedByService =
    serviceStatus?.__missing !== true &&
    serviceStatus?.service?.statusFresh === true &&
    serviceStatus?.quote?.status === "session_closed";
  const domesticFreshByService =
    serviceStatus?.__missing !== true &&
    serviceStatus?.service?.statusFresh === true &&
    serviceStatus?.quote?.ready === true &&
    serviceStatus?.quote?.status === "fresh";
  const overseasFreshByService =
    serviceStatus?.__missing !== true &&
    serviceStatus?.service?.statusFresh === true &&
    serviceStatus?.quote?.ready === true &&
    serviceStatus?.quote?.status === "fresh";
  const callbackReadbackSafeByService =
    serviceStatus?.__missing !== true &&
    serviceStatus?.service?.statusFresh === true &&
    (serviceStatus?.quote?.status === "fresh" || serviceStatus?.quote?.status === "session_closed");
  const domesticFresh =
    domesticFreshByCallback || domesticFreshByService || quoteSessionClosedByService;
  const overseasFresh =
    overseasFreshByCallback || overseasFreshByService || quoteSessionClosedByService;
  const paperStrategyReady =
    paperEvaluation.status === "evaluated" && paperEvaluation.recommendation === "promote";
  const preTradeRiskClear =
    liveOrderDryRunPretrade.schema === "openclaw.capital.live-order-dry-run-pretrade-gate.v1" &&
    liveOrderDryRunPretrade.status === "live_order_dry_run_pretrade_blocked" &&
    liveOrderDryRunPretrade.preTradeRiskGate?.attachedBeforeBrokerSend === true &&
    liveOrderDryRunPretrade.preTradeRiskGate?.evaluated === true &&
    liveOrderDryRunPretrade.safety?.sentOrder === false;
  const semiApprovalClear =
    telegramSemiApproval.schema === "openclaw.capital.telegram-semi-approval-gate.v1" &&
    telegramSemiApproval.status === "semi_approval_pending_live_blocked" &&
    telegramSemiApproval.promotionGate?.status === "blocked" &&
    telegramSemiApproval.safety?.sentOrder === false &&
    telegramSemiCallback.schema === "openclaw.capital.telegram-semi-approval-callback.v1" &&
    ["callback_review_checklist_ready", "callback_review_checklist_written"].includes(
      telegramSemiCallback.status,
    ) &&
    telegramSemiCallback.safety?.sentOrder === false;
  const latencyGapClear =
    latencyGapInstrumentation.schema === "openclaw.capital.latency-gap-instrumentation.v1" &&
    latencyGapInstrumentation.status === "passed" &&
    latencyGapInstrumentation.safety?.sentOrder === false &&
    latencyGapInstrumentation.safety?.liveTradingEnabled === false &&
    latencyGapInstrumentation.safety?.writeBrokerOrders === false;
  const serviceChecks = [
    check(
      "service:status-running",
      hftStatus.status === "running",
      "CapitalHftService must be running.",
      {
        status: hftStatus.status ?? "",
        pid: hftStatus.pid ?? null,
      },
    ),
    check(
      "service:login-connected",
      hftStatus.loginStatus === "connected" && hftStatus.loginCode === 0,
      "Capital login must be connected.",
      {
        loginStatus: hftStatus.loginStatus ?? "",
        loginCode: hftStatus.loginCode ?? null,
        loginMethod: hftStatus.loginMethod ?? "",
      },
    ),
    check(
      "service:domestic-quote-connected",
      hftStatus.quoteMonitorConnected === true,
      "Domestic quote monitor must be connected.",
      {
        quoteMonitorConnected: hftStatus.quoteMonitorConnected ?? false,
        quoteCount: hftStatus.quoteStats?.quoteCount ?? 0,
      },
    ),
    check(
      "service:overseas-quote-connected",
      hftStatus.osQuoteConnected === true,
      "Overseas quote monitor must be connected.",
      {
        osQuoteConnected: hftStatus.osQuoteConnected ?? false,
        osQuoteCount: hftStatus.osQuoteStats?.quoteCount ?? 0,
      },
    ),
    check(
      "service:domestic-quote-fresh",
      domesticFresh,
      "Domestic quote callback must be fresh for strategy use.",
      {
        lastQuoteAt: hftStatus.quoteStats?.lastQuoteAt ?? "",
        ageMs: domesticQuoteAgeMs,
        maxAgeMs: 120_000,
        callbackFresh: domesticFreshByCallback,
        serviceFallbackFresh: domesticFreshByService,
        serviceSessionClosedAccepted: quoteSessionClosedByService,
        serviceStatusFresh: serviceStatus?.service?.statusFresh ?? null,
        serviceQuoteStatus: serviceStatus?.quote?.status ?? "",
        serviceQuoteReason: serviceStatus?.quote?.reason ?? "",
      },
    ),
    check(
      "service:overseas-quote-fresh",
      overseasFresh,
      "Overseas quote callback must be fresh for strategy use.",
      {
        lastQuoteAt: hftStatus.osQuoteStats?.lastQuoteAt ?? "",
        ageMs: overseasQuoteAgeMs,
        maxAgeMs: 120_000,
        callbackFresh: overseasFreshByCallback,
        serviceFallbackFresh: overseasFreshByService,
        serviceSessionClosedAccepted: quoteSessionClosedByService,
        serviceQuoteStatus: serviceStatus?.quote?.status ?? "",
        serviceQuoteReason: serviceStatus?.quote?.reason ?? "",
      },
    ),
    check(
      "service:order-initialized-readonly",
      hftStatus.orderInitialized === true,
      "Order channel may be initialized, but this readiness report stays read-only.",
      {
        orderInitialized: hftStatus.orderInitialized ?? false,
      },
    ),
    check(
      "service:live-write-disabled",
      hftStatus.riskControls?.allowLiveTrading === false &&
        hftStatus.riskControls?.writeBrokerOrders === false,
      "Live broker writes must remain disabled until manual promotion.",
      {
        allowLiveTrading: hftStatus.riskControls?.allowLiveTrading ?? null,
        writeBrokerOrders: hftStatus.riskControls?.writeBrokerOrders ?? null,
      },
    ),
  ];
  const strategyChecks = [
    check(
      "strategy:paper-evaluator-promote",
      paperStrategyReady,
      "Paper strategy evaluator must recommend promote before strategy automation.",
      {
        status: paperEvaluation.status,
        recommendation: paperEvaluation.recommendation,
        passCount: paperEvaluation.passCount,
      },
    ),
    check(
      "strategy:callback-readback-safe",
      callbackReadback.__missing === true ||
        callbackReadback.quoteFreshAllowed === true ||
        callbackReadbackSafeByService,
      "Callback readback must either be absent or explicitly allow fresh quote reporting.",
      {
        missing: callbackReadback.__missing === true,
        quoteFreshAllowed: callbackReadback.quoteFreshAllowed ?? null,
        freshMatchedCount: callbackReadback.summary?.freshMatchedCount ?? null,
        staleOrMissingCount: callbackReadback.summary?.staleOrMissingCount ?? null,
        serviceFallbackAccepted: callbackReadbackSafeByService,
        serviceQuoteStatus: serviceStatus?.quote?.status ?? "",
        serviceQuoteReason: serviceStatus?.quote?.reason ?? "",
      },
    ),
  ];
  const liveChecks = [
    check(
      "live:promotion-gate-present",
      liveGateResult.report.schema === "openclaw.capital.live-trading-promotion-gate.v1",
      "Live promotion gate must produce the expected schema.",
      {
        schema: liveGateResult.report.schema ?? "",
      },
    ),
    check(
      "live:blocked-by-design",
      isCapitalLivePromotionManualReviewOnly(liveGateResult.report),
      "Live trading must remain blocked or manual-review-only in automation.",
      {
        status: liveGateResult.report.status,
        readyForManualReview: liveGateResult.report.readyForManualReview,
        blockerCode: liveGateResult.report.blockerCode,
        blockers: liveGateResult.report.blockers,
      },
    ),
    check(
      "live:no-broker-write",
      liveGateResult.report.liveTradingEnabled === false &&
        liveGateResult.report.writeTradingEnabled === false &&
        liveGateResult.report.sentOrder === false,
      "This task must not enable live trading, write broker orders, or send orders.",
      {
        liveTradingEnabled: liveGateResult.report.liveTradingEnabled,
        writeTradingEnabled: liveGateResult.report.writeTradingEnabled,
        sentOrder: liveGateResult.report.sentOrder,
      },
    ),
  ];

  const checks = [...serviceChecks, ...strategyChecks, ...liveChecks];
  const serviceReady =
    failedIds(serviceChecks.filter(isOperationalServiceReadinessCheck)).length === 0;
  const strategyReady = failedIds(strategyChecks).length === 0 && paperStrategyReady;
  const paperStrategyExecutionReady = serviceReady && strategyReady;
  const liveBlockers = [
    ...liveGateResult.report.blockers,
    preTradeRiskClear ? null : "live:pre-trade-risk-gate-required",
    semiApprovalClear ? null : "live:semi-approval-required",
    latencyGapClear ? null : "live:latency-gap-instrumentation-required",
  ].filter(Boolean);

  const report = {
    schema: "openclaw.capital.live-strategy-readiness.v1",
    generatedAt: now.toISOString(),
    mode: "paper_strategy_ready_live_blocked",
    status: paperStrategyExecutionReady ? "paper_ready_live_blocked" : "blocked",
    capitalRoot,
    reportPath,
    capabilities: {
      paperStrategyExecution: paperStrategyExecutionReady,
      liveStrategyExecution: false,
      liveTradingExecution: false,
      brokerWriteExecution: false,
      sentOrder: false,
    },
    safety: {
      allowLiveTrading: false,
      writeBrokerOrders: false,
      promoteLiveAutomatically: false,
      loginAttemptedByThisScript: false,
      readOnlyPreflightOnly: true,
    },
    service: {
      status: hftStatus.status ?? "unknown",
      loginStatus: hftStatus.loginStatus ?? "unknown",
      quoteMonitorConnected: hftStatus.quoteMonitorConnected ?? false,
      osQuoteConnected: hftStatus.osQuoteConnected ?? false,
      orderInitialized: hftStatus.orderInitialized ?? false,
      domesticQuoteAgeMs,
      overseasQuoteAgeMs,
      domesticQuoteFreshByCallback: domesticFreshByCallback,
      domesticQuoteFreshByService: domesticFreshByService,
      overseasQuoteFreshByCallback: overseasFreshByCallback,
      overseasQuoteFreshByService: overseasFreshByService,
      serviceQuoteSessionClosedAccepted: quoteSessionClosedByService,
      subscribedStocks: hftStatus.subscribedStocks ?? [],
      subscribedOsStocks: hftStatus.subscribedOsStocks ?? [],
    },
    paperStrategy: {
      status: paperEvaluation.status,
      recommendation: paperEvaluation.recommendation,
      passCount: paperEvaluation.passCount,
      rules: paperEvaluation.rules ?? {},
    },
    preTradeRisk: {
      clear: preTradeRiskClear,
      status: liveOrderDryRunPretrade.status ?? "missing",
    },
    semiApproval: {
      clear: semiApprovalClear,
      status: telegramSemiApproval.status ?? "missing",
      callbackStatus: telegramSemiCallback.status ?? "missing",
    },
    latencyGap: {
      clear: latencyGapClear,
      status: latencyGapInstrumentation.status ?? "missing",
    },
    livePromotion: {
      status: liveGateResult.report.status,
      blockerCode: liveGateResult.report.blockerCode,
      blockers: liveBlockers,
      readyForManualReview: liveGateResult.report.readyForManualReview,
    },
    checks,
    blockers: failedIds(checks),
    nextSafeTask: paperStrategyExecutionReady
      ? latencyGapClear
        ? "持續 paper strategy controlled loop；真實下單仍需人工 approval、kill switch、rollback、simulation risk gate 全部通過。"
        : "啟用 paper strategy controlled loop；真實下單仍需先補 LatencyMonitor / GapDetector instrumentation 並通過人工 promotion。"
      : "先修 service quote freshness 或 paper strategy evaluation，再重跑 live-strategy readiness；真實下單保持 blocked。",
  };

  if (options.writeState === true) {
    await writeJsonWithSha(reportPath, report);
  }

  return { report, reportPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await runCapitalLiveStrategyReadiness({
    capitalRoot: argValue("--capital-root", DEFAULT_CAPITAL_ROOT),
    reportPath: argValue("--report", DEFAULT_REPORT_PATH),
    writeState: hasFlag("--write-state"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital live strategy readiness",
        `status=${result.report.status}`,
        `paperStrategyExecution=${result.report.capabilities.paperStrategyExecution}`,
        `liveTradingExecution=${result.report.capabilities.liveTradingExecution}`,
        `liveBlockerCode=${result.report.livePromotion.blockerCode}`,
        `nextSafeTask=${result.report.nextSafeTask}`,
      ].join("\n") + "\n",
    );
  }
}
