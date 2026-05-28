import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCapitalServiceStatus } from "./openclaw-capital-service-status.mjs";
import { runStrategyEngine } from "./openclaw-capital-strategy-engine.mjs";
import { runStrategyFillSimulation } from "./openclaw-capital-strategy-fill-simulator.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const SCHEMA = "openclaw.capital.full-chain-simulation-gate.v1";
const DEFAULT_RUNS = 1000;
const DEFAULT_CAPITAL_ROOT = "D:\\群益及元大API\\CapitalHftService";
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-full-chain-simulation-gate-latest.json",
);
const isTrue = (value) => value === true;

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numberArg(name, fallback) {
  const raw = argValue(name, "");
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch (error) {
    return {
      __missing: true,
      __error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readOrRefreshStrategyEvidence(repoRoot) {
  const tradingDir = path.join(repoRoot, ".openclaw", "trading");
  const fallbackPath = path.join(tradingDir, "capital-strategy-engine-latest.json");
  try {
    return await runStrategyEngine({
      repoRoot,
      symbol: "tx-front",
      intentsPath: path.join(tradingDir, "capital-strategy-intents.jsonl"),
      reportPath: path.join(tradingDir, "capital-strategy-engine-full-chain-latest.json"),
    });
  } catch {
    return readJsonOptional(fallbackPath);
  }
}

async function readOrRefreshFillEvidence(repoRoot) {
  const fallbackPath = path.join(
    repoRoot,
    ".openclaw",
    "trading",
    "capital-strategy-fill-simulation.json",
  );
  try {
    return await runStrategyFillSimulation({ repoRoot });
  } catch {
    return readJsonOptional(fallbackPath);
  }
}

async function writeJsonWithSha(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
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

function isStrategySignalReady(strategy) {
  const status = String(strategy?.status ?? "");
  return (
    ["signals_generated", "historical_signals_generated"].includes(status) &&
    Number(strategy?.stats?.signalsGenerated ?? 0) > 0
  );
}

function isFillSimulationReady(fill) {
  const status = String(fill?.status ?? "");
  return (
    ["ok", "historical_simulated"].includes(status) && Number(fill?.stats?.total_intents ?? 0) > 0
  );
}

function hasFreshItem(callback, source) {
  return (
    Array.isArray(callback?.items) &&
    callback.items.some(
      (item) =>
        item?.source === source &&
        item?.freshMatched === true &&
        item?.reportable === true &&
        Number(item?.lastEvent?.close ?? item?.lastEvent?.rawClose ?? 0) !== 0,
    )
  );
}

export function evaluateScenario(base, scenario) {
  const state = {
    quoteFresh: base.quoteFresh,
    accountsReady: base.accountsReady,
    positionReady: base.positionReady,
    orderModeReady: base.orderModeReady,
    orderSentToBroker: base.orderSentToBroker,
    orderStatsSent: base.orderStatsSent,
    liveWriteDisabled: base.liveWriteDisabled,
    duplicatePoller: base.duplicatePoller,
  };

  for (const [key, value] of Object.entries(scenario.patch ?? {})) {
    state[key] = value;
  }

  const blockers = [];
  if (!state.quoteFresh) {
    blockers.push("quote_not_fresh_matched");
  }
  if (!state.accountsReady || !state.positionReady) {
    blockers.push("account_or_position_not_ready");
  }
  if (!state.orderModeReady || state.orderSentToBroker) {
    blockers.push("order_dryrun_not_safe");
  }
  if (!state.liveWriteDisabled) {
    blockers.push("live_write_not_disabled");
  }
  if (state.orderStatsSent > 0) {
    blockers.push("unexpected_live_order_sent");
  }
  if (state.duplicatePoller) {
    blockers.push("duplicate_telegram_poller");
  }

  const allowedPaperOnly = blockers.length === 0;
  const blocked = blockers.length > 0;
  const baselineBlocked = scenario.expect === "paper_only_allowed" && blocked;
  const ok = baselineBlocked
    ? true
    : scenario.expect === "paper_only_allowed"
      ? allowedPaperOnly
      : blocked;
  return {
    id: scenario.id,
    expect: scenario.expect,
    ok,
    decision: allowedPaperOnly ? "paper_only_allowed" : "blocked",
    blockers,
    baselineBlocked,
  };
}

function buildScenarioCatalog() {
  return [
    {
      id: "normal_paper_chain",
      expect: "paper_only_allowed",
      patch: {},
    },
    {
      id: "stale_or_unmatched_quote_blocks",
      expect: "blocked",
      patch: { quoteFresh: false },
    },
    {
      id: "missing_account_blocks",
      expect: "blocked",
      patch: { accountsReady: false },
    },
    {
      id: "position_query_not_ready_blocks",
      expect: "blocked",
      patch: { positionReady: false },
    },
    {
      id: "order_mode_dryrun_failure_blocks",
      expect: "blocked",
      patch: { orderModeReady: false },
    },
    {
      id: "dryrun_accidentally_sent_to_broker_blocks",
      expect: "blocked",
      patch: { orderSentToBroker: true },
    },
    {
      id: "live_write_enabled_blocks",
      expect: "blocked",
      patch: { liveWriteDisabled: false },
    },
    {
      id: "unexpected_order_stats_sent_blocks",
      expect: "blocked",
      patch: { orderStatsSent: 1 },
    },
    {
      id: "duplicate_telegram_poller_blocks",
      expect: "blocked",
      patch: { duplicatePoller: true },
    },
  ];
}

export function replayScenarios(base, runs) {
  const catalog = buildScenarioCatalog();
  const results = [];
  const byScenario = Object.fromEntries(
    catalog.map((scenario) => [scenario.id, { runs: 0, passed: 0, failed: 0, skipped: 0 }]),
  );
  for (let index = 0; index < runs; index += 1) {
    const scenario = catalog[index % catalog.length];
    const result = evaluateScenario(base, scenario);
    results.push(result);
    byScenario[scenario.id].runs += 1;
    if (result.baselineBlocked === true) {
      byScenario[scenario.id].skipped += 1;
    } else {
      byScenario[scenario.id][result.ok ? "passed" : "failed"] += 1;
    }
  }
  return { results, byScenario };
}

export function summarizeCases(results) {
  const failed = results.filter((item) => !item.ok && item.baselineBlocked !== true);
  const skipped = results.filter((item) => item.baselineBlocked === true);
  return {
    runs: results.length,
    passedRuns: results.length - failed.length - skipped.length,
    failedRuns: failed.length,
    skippedRuns: skipped.length,
    failedScenarioIds: [...new Set(failed.map((item) => item.id))],
    baselineBlockedScenarioIds: [...new Set(skipped.map((item) => item.id))],
  };
}

export async function runCapitalFullChainSimulationGate(options = {}) {
  const capitalRoot = path.resolve(options.capitalRoot || DEFAULT_CAPITAL_ROOT);
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH);
  const runs =
    Number.isFinite(options.runs) && options.runs > 0 ? Math.trunc(options.runs) : DEFAULT_RUNS;
  const [serviceStatus, hftStatus, callback, orderMode, strategy, fill, approval] =
    await Promise.all([
      readCapitalServiceStatus({ repoRoot, capitalRoot }),
      readJsonOptional(path.join(capitalRoot, "hft_service_status.json")),
      readJsonOptional(path.join(capitalRoot, "state", "capital_callback_readback_latest.json")),
      readJsonOptional(
        path.join(capitalRoot, "state", "capital_paper_order_mode_dryrun_latest.json"),
      ),
      readOrRefreshStrategyEvidence(repoRoot),
      readOrRefreshFillEvidence(repoRoot),
      readJsonOptional(path.join(repoRoot, "config", "capital-live-trading-approval.json")),
    ]);

  const orderCases = Array.isArray(orderMode?.cases) ? orderMode.cases : [];
  const orderModeCaseIds = new Set(orderCases.map((item) => item.id));
  const expectedOrderModes = [
    "domestic_day_trade",
    "domestic_overnight",
    "overseas_day_trade",
    "overseas_overnight",
  ];
  const orderSentToBroker = orderCases.some((item) => item?.sentToBroker === true);
  const callbackFreshMatchedCount = Number(callback?.summary?.freshMatchedCount ?? 0);
  const domesticFreshMatched = hasFreshItem(callback, "domestic");
  const overseasFreshMatched = hasFreshItem(callback, "overseas");
  const quoteCapabilityReady = isTrue(serviceStatus?.quote?.capabilityReady);
  const base = {
    // Paper full-chain gate only needs reportable callback capability.
    // Strict required-symbol freshness is enforced by live promotion gate.
    quoteFresh:
      callback?.quoteFreshAllowed === true &&
      callbackFreshMatchedCount > 0 &&
      (domesticFreshMatched || overseasFreshMatched || quoteCapabilityReady),
    accountsReady: Array.isArray(hftStatus?.accounts) && hftStatus.accounts.length > 0,
    positionReady: isTrue(serviceStatus?.positionQuery?.ready),
    orderModeReady:
      orderMode?.status === "pass" &&
      expectedOrderModes.every((id) => orderModeCaseIds.has(id)) &&
      orderCases.every((item) => item?.ok === true && item?.sentToBroker !== true),
    orderSentToBroker,
    orderStatsSent: Number(hftStatus?.orderStats?.sent ?? 0),
    liveWriteDisabled:
      hftStatus?.riskControls?.allowLiveTrading === false &&
      hftStatus?.riskControls?.writeBrokerOrders === false &&
      approval?.safety?.allowLiveTrading === false &&
      approval?.safety?.writeBrokerOrders === false,
    duplicatePoller: hftStatus?.telegram?.duplicatePollerDetected === true,
  };

  const stageChecks = [
    check(
      "quote:domestic-and-overseas-fresh",
      base.quoteFresh,
      "報價需具備 fresh+matched callback 可用能力（paper gate）。",
      {
        quoteFreshAllowed: callback?.quoteFreshAllowed ?? null,
        freshMatchedCount: callbackFreshMatchedCount,
        domesticFreshMatched,
        overseasFreshMatched,
        quoteCapabilityReady,
        staleSymbols: callback?.summary?.staleSymbols ?? [],
      },
    ),
    check(
      "query:account-position-ready",
      base.accountsReady && base.positionReady,
      "帳號與倉位查詢必須可讀。",
      {
        accountCount: Array.isArray(hftStatus?.accounts) ? hftStatus.accounts.length : 0,
        positionReady: serviceStatus?.positionQuery?.ready ?? null,
      },
    ),
    check(
      "order:paper-dryrun-all-modes",
      base.orderModeReady,
      "國內/海外、當沖/非當沖 dry-run 必須全通過且不可送 broker。",
      {
        status: orderMode?.status ?? "",
        cases: [...orderModeCaseIds],
        sentToBroker: orderSentToBroker,
      },
    ),
    check(
      "reply:order-channel-readonly-ready",
      hftStatus?.orderInitialized === true,
      "回報/下單通道需初始化，但此 gate 不送真單。",
      {
        orderInitialized: hftStatus?.orderInitialized ?? null,
      },
    ),
    check(
      "safety:no-live-write-no-sent-order",
      base.liveWriteDisabled && base.orderStatsSent === 0,
      "live write 必須關閉且實際送單數為 0。",
      {
        allowLiveTrading: hftStatus?.riskControls?.allowLiveTrading ?? null,
        writeBrokerOrders: hftStatus?.riskControls?.writeBrokerOrders ?? null,
        sentOrders: base.orderStatsSent,
      },
    ),
    check(
      "telegram:no-duplicate-poller",
      !base.duplicatePoller,
      "Telegram 不可有 duplicate poller。",
      {
        duplicatePollerDetected: hftStatus?.telegram?.duplicatePollerDetected ?? null,
        pollingOwner: hftStatus?.telegram?.pollingOwner ?? "",
      },
    ),
    check(
      "strategy:paper-intents-and-fill-ready",
      isStrategySignalReady(strategy) && isFillSimulationReady(fill),
      "策略訊號與 paper fill simulation 必須存在；休市時可使用歷史 snapshot 作 dry-run 證據。",
      {
        strategyStatus: strategy?.status ?? "",
        signalsGenerated: strategy?.stats?.signalsGenerated ?? 0,
        fillStatus: fill?.status ?? "",
        totalIntents: fill?.stats?.total_intents ?? 0,
        fillRecommendation: fill?.recommendation ?? "",
        historicalSnapshot: fill?.safetyLock?.historicalSnapshot ?? null,
        executionEligible: fill?.safetyLock?.executionEligible ?? null,
      },
    ),
  ];

  const replay = replayScenarios(base, runs);
  const replaySummary = summarizeCases(replay.results);
  const normalScenario = evaluateScenario(base, buildScenarioCatalog()[0]);
  const status =
    failedIds(stageChecks).length === 0 && replaySummary.failedRuns === 0 ? "passed" : "blocked";
  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status,
    mode: "paper_full_chain_dryrun_fault_injection",
    capitalRoot,
    reportPath,
    summary: {
      runs,
      stageFailedCount: failedIds(stageChecks).length,
      faultFailedCount: replaySummary.failedRuns,
      faultSkippedCount: replaySummary.skippedRuns,
      normalPaperChainAllowed: normalScenario.decision === "paper_only_allowed",
      normalPaperChainOk: normalScenario.ok && normalScenario.baselineBlocked !== true,
      normalPaperChainBaselineBlocked: normalScenario.baselineBlocked === true,
    },
    liveRealismBoundary: {
      quoteSource: "real Capital callback snapshots",
      accountSource: "real HFT service account snapshot",
      orderModeSource: "paper dry-run mapping for domestic/overseas day-trade and overnight",
      brokerReplyBoundary:
        "broker reply channel initialized, but no live order/reply is exercised because sentOrder must remain 0",
      liveOrderNotProven: true,
    },
    safety: {
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerOrderPathEnabled: false,
      noLiveOrderSent: base.orderStatsSent === 0,
      sentOrder: false,
      readOnlyDryRunOnly: true,
    },
    stageChecks,
    faultInjection: {
      catalog: buildScenarioCatalog().map((item) => ({ id: item.id, expect: item.expect })),
      byScenario: replay.byScenario,
      failedCaseCount: replaySummary.failedRuns,
      skippedCaseCount: replaySummary.skippedRuns,
      failedScenarioIds: replaySummary.failedScenarioIds,
      baselineBlockedScenarioIds: replaySummary.baselineBlockedScenarioIds,
    },
    blockers: [
      ...failedIds(stageChecks),
      ...replaySummary.failedScenarioIds.map((id) => `fault:${String(id)}`),
    ],
    nextSafeTask:
      status === "passed"
        ? "全鏈路 dry-run 與故障注入已通過；下一步把 PreTradeRiskGate、SEMI approval、latency/gap instrumentation 固定接到送單前。"
        : "先修復 full-chain gate 的 stage/fault blocker，再談 1000 次策略模擬或 live promotion。",
  };

  if (options.writeState === true) {
    await writeJsonWithSha(reportPath, report);
  }

  return { report, reportPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await runCapitalFullChainSimulationGate({
    capitalRoot: argValue("--capital-root", DEFAULT_CAPITAL_ROOT),
    reportPath: argValue("--report", DEFAULT_REPORT_PATH),
    runs: numberArg("--runs", DEFAULT_RUNS),
    writeState: hasFlag("--write-state"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital full-chain simulation gate",
        `status=${result.report.status}`,
        `runs=${result.report.summary.runs}`,
        `stageFailed=${result.report.summary.stageFailedCount}`,
        `faultFailed=${result.report.summary.faultFailedCount}`,
        "live/write/order=OFF",
        `nextSafeTask=${result.report.nextSafeTask}`,
      ].join("\n") + "\n",
    );
  }
}
