import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBarAccumulator } from "./openclaw-capital-bar-accumulator.mjs";
import {
  runCapitalPaperAssistantState,
  writeCapitalPaperAssistantState,
} from "./openclaw-capital-paper-assistant-state.mjs";
import { runCapitalPaperAutoReview } from "./openclaw-capital-paper-auto-review.mjs";
import { runCapitalPaperFillSimulation } from "./openclaw-capital-paper-fill-simulator.mjs";
import {
  readCapitalPaperHftReadinessReport,
  writeCapitalPaperHftReadinessReport,
} from "./openclaw-capital-paper-hft-readiness.mjs";
import { runCapitalPaperStrategyEvaluator } from "./openclaw-capital-paper-strategy-evaluator.mjs";
import {
  buildCapitalPaperTradingCycle,
  writeCapitalPaperTradingCycle,
} from "./openclaw-capital-paper-trading-simulator.mjs";
import {
  buildCapitalQuoteArchitectureReport,
  writeCapitalQuoteArchitectureReport,
} from "./openclaw-capital-quote-architecture.mjs";
import { runCapitalQuotePump } from "./openclaw-capital-quote-pump.mjs";
import { runStrategyEngine } from "./openclaw-capital-strategy-engine.mjs";

function defaultArchitectureReportPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-quote-architecture-report.json");
}

function defaultReadinessPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-hft-readiness.json");
}

function defaultOutputDir(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading");
}

function defaultRiskConfigPath(repoRoot) {
  return path.join(repoRoot, "config", "capital-paper-hft-risk-controls.json");
}

function defaultStrategyPath(repoRoot) {
  return path.join(repoRoot, "config", "capital-paper-microstructure-strategy.json");
}

function defaultLoopReportPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-automation-loop-latest.json");
}

function defaultAssistantStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "ui", "capital-paper-assistant-state.json");
}

function defaultAliasAssistantStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "ui", "auto-trading-assistant-state.json");
}

export function strategyEngineSymbolForPaperConfig(strategy = {}) {
  const raw = strategy.strategySymbol || strategy.targetStockNo || strategy.symbol || "tx-front";
  const normalized = String(raw).trim().toUpperCase();
  const legacySessionAlias = normalized.match(/^(?<base>TX\d{2})(?:AM|PM)$/u);
  return legacySessionAlias?.groups?.base ?? raw;
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readJson(filePath, label) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
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
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function loopStatus({ pumpReport, architectureReport, readinessReport, tradingCycle }) {
  if (pumpReport.status === "blocked_1115") {
    return "blocked_1115";
  }
  if (pumpReport.status === "session_closed") {
    return "session_closed";
  }
  if (architectureReport.status !== "passed") {
    return "blocked_architecture";
  }
  if (readinessReport.ready !== true) {
    return "blocked_readiness";
  }
  return tradingCycle.status;
}

function loopNextSafeTask(report) {
  if (report.status === "paper_intent_created") {
    return "持續由 heartbeat 重跑 capital-hft:paper-loop；累積 paper learning，不啟用真實下單。";
  }
  if (report.status === "blocked_1115") {
    return "等待 guard cooldown 到期；禁止登入、禁止推進 StartIndex，只更新 OpenClaw 狀態。";
  }
  if (report.status === "session_closed") {
    return "等待台指日盤 / 夜盤交易時段開啟；不要用休市 tick 產生 paper intent。";
  }
  if (report.pump.status === "stale") {
    return "等待 CapitalHftService 寫入新的 SKQuoteLib quote callback，再重跑 paper loop。";
  }
  if (report.readiness.ready !== true) {
    return "修正 readiness failed gates；仍禁止 broker write path。";
  }
  return "檢查 paper simulator 的 quote/bid/ask gate，維持 paper-only。";
}

export async function runCapitalPaperAutomationLoop(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const outputDir = path.resolve(options.outputDir || defaultOutputDir(repoRoot));
  const architectureReportPath = path.resolve(
    options.architectureReportPath || defaultArchitectureReportPath(repoRoot),
  );
  const readinessPath = path.resolve(options.readinessPath || defaultReadinessPath(repoRoot));
  const riskConfigPath = path.resolve(options.riskConfigPath || defaultRiskConfigPath(repoRoot));
  const strategyPath = path.resolve(options.strategyPath || defaultStrategyPath(repoRoot));
  const reportPath = path.resolve(options.reportPath || defaultLoopReportPath(repoRoot));
  const assistantStatePath = path.resolve(
    options.assistantStatePath || defaultAssistantStatePath(repoRoot),
  );
  const streamPath = path.join(path.dirname(reportPath), "capital-paper-automation-loops.jsonl");
  const strategy = await readJson(strategyPath, "Capital paper microstructure strategy");
  const useAnyFreshAllowedSymbol = strategy.useAnyFreshAllowedSymbol === true;
  const strategyEngineSymbol = strategyEngineSymbolForPaperConfig(strategy);

  const pump = await runCapitalQuotePump({
    repoRoot,
    stateDir: options.stateDir || undefined,
    riskConfigPath,
    targetStockNo: useAnyFreshAllowedSymbol ? "" : strategy.targetStockNo || strategy.symbol || "",
    targetStockNos: useAnyFreshAllowedSymbol
      ? []
      : Array.isArray(strategy.targetStockNos)
        ? strategy.targetStockNos
        : [],
    quoteAliases: useAnyFreshAllowedSymbol
      ? []
      : Array.isArray(strategy.quoteAliases)
        ? strategy.quoteAliases
        : [],
    marketCode: useAnyFreshAllowedSymbol ? "" : strategy.marketCode || options.marketCode || "",
    maxQuoteAgeSeconds: options.maxQuoteAgeSeconds,
  });

  const architectureReport = await buildCapitalQuoteArchitectureReport({
    repoRoot,
    statusPath: pump.report.files.statusPath,
    eventPath: pump.report.files.runtimeEventPath,
    outputPath: architectureReportPath,
    requireGeneratedState: true,
  });
  await writeCapitalQuoteArchitectureReport(architectureReport, architectureReportPath);

  const readinessReport = await readCapitalPaperHftReadinessReport({
    repoRoot,
    architectureReportPath,
    eventPath: pump.report.files.runtimeEventPath,
    riskConfigPath,
    outputPath: readinessPath,
  });
  await writeCapitalPaperHftReadinessReport(readinessReport, readinessPath);

  const learningRegistryPath = path.join(outputDir, "capital-paper-learning-registry.json");
  const [quoteState, previousLearning] = await Promise.all([
    readJson(pump.report.files.readerStatePath, "Capital quote state"),
    readOptionalJson(learningRegistryPath, {}),
  ]);
  const trading = buildCapitalPaperTradingCycle({
    readiness: readinessReport,
    quoteState,
    strategy,
    previousLearning,
  });
  const tradingFiles = await writeCapitalPaperTradingCycle(trading, outputDir);

  const report = {
    schema: "openclaw.capital.paper-automation-loop.v1",
    generatedAt: new Date().toISOString(),
    provider: "capital",
    mode: "paper",
    readOnlyQuoteOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    hftLikeAutomation: true,
    status: loopStatus({
      pumpReport: pump.report,
      architectureReport,
      readinessReport,
      tradingCycle: trading.cycle,
    }),
    pump: {
      status: pump.report.status,
      ready: pump.report.ready,
      quote: pump.report.quote,
    },
    architecture: {
      status: architectureReport.status,
      passed: architectureReport.summary.passed,
      failed: architectureReport.summary.failed,
      eventType: architectureReport.summary.eventType,
      strategyGateReady: architectureReport.summary.strategyGateReady,
    },
    readiness: {
      status: readinessReport.status,
      ready: readinessReport.ready,
      failed: readinessReport.summary.failed,
      quoteAgeSeconds: readinessReport.summary.quoteAgeSeconds,
      maxQuoteAgeSeconds: readinessReport.summary.maxQuoteAgeSeconds,
      latestStock: readinessReport.summary.latestStock,
    },
    trading: {
      cycleId: trading.cycle.cycleId,
      status: trading.cycle.status,
      reason: trading.cycle.reason,
      paperIntentCreated: trading.cycle.paperIntent != null,
      paperIntentId: trading.cycle.paperIntent?.intentId ?? "",
      quote: {
        stockNo: trading.cycle.quote.stockNo,
        close: trading.cycle.quote.close,
        bid: trading.cycle.quote.bid,
        ask: trading.cycle.quote.ask,
        qty: trading.cycle.quote.qty,
      },
    },
    learning: {
      status: trading.learningRegistry.status,
      paperEligible: trading.learningRegistry.paperEligible,
      liveEligible: trading.learningRegistry.liveEligible,
      counters: trading.learningRegistry.counters,
      autoReview: {
        status: "",
        promoted: false,
        liveStillBlocked: true,
      },
    },
    files: {
      reportPath,
      streamPath,
      assistantStatePath,
      pumpReportPath: pump.report.files.reportPath,
      quoteStatePath: pump.report.files.readerStatePath,
      quoteStatusPath: pump.report.files.statusPath,
      runtimeEventPath: pump.report.files.runtimeEventPath,
      architectureReportPath,
      readinessPath,
      tradingCyclePath: tradingFiles.latestCyclePath,
      paperIntentPath: tradingFiles.latestIntentPath,
      learningRegistryPath: tradingFiles.learningRegistryPath,
      learningSummaryPath: tradingFiles.learningSummaryPath,
    },
  };
  report.nextSafeTask = loopNextSafeTask(report);

  // K 棒累積器：每日保存分鐘棒到歷史資料庫
  const barAccResult = await runBarAccumulator({
    repoRoot,
    symbol: strategyEngineSymbol,
  }).catch(() => ({ status: "error", newMinuteBars: 0, totalMinuteBars: 0, totalDays: 0 }));
  report.barAccumulator = {
    status: barAccResult.status ?? "error",
    newBars: barAccResult.newMinuteBars ?? 0,
    totalBars: barAccResult.totalMinuteBars ?? 0,
    totalDays: barAccResult.totalDays ?? 0,
    newDates: barAccResult.newDates ?? [],
  };

  // 策略引擎：從 tick 流產生方向性信號（ORB/EMA/VWAP），寫入獨立 intents 檔
  const strategyEngineResult = await runStrategyEngine({
    repoRoot,
    symbol: strategyEngineSymbol,
    intentsPath: path.join(outputDir, "capital-paper-loop-strategy-intents.jsonl"),
    reportPath: path.join(outputDir, "capital-paper-loop-strategy-engine-latest.json"),
    appendIntents: false, // 每次重跑從 tick 流重新生成
  }).catch((err) => ({
    status: "error",
    error: err instanceof Error ? err.message : String(err),
    stats: { totalTicks: 0, barsBuilt: 0, signalsGenerated: 0, intentsWritten: 0 },
    safetyLock: {
      allowLiveTrading: false,
      writeBrokerOrders: false,
      promoteLiveAutomatically: false,
    },
  }));
  report.strategy = {
    status: strategyEngineResult.status ?? "error",
    ticks: strategyEngineResult.stats?.totalTicks ?? 0,
    bars: strategyEngineResult.stats?.barsBuilt ?? 0,
    signals: strategyEngineResult.stats?.signalsGenerated ?? 0,
    byType: strategyEngineResult.stats?.byStrategy ?? { orb: 0, ema: 0, vwap: 0 },
    dayRange: strategyEngineResult.market?.dayRange ?? 0,
    lastPrice: strategyEngineResult.market?.lastPrice ?? 0,
    liveStillBlocked: strategyEngineResult.safetyLock?.allowLiveTrading === false,
    error: strategyEngineResult.error ?? "",
  };

  let paperFillSimulation = null;
  let paperEvaluation = null;
  if (trading.cycle.status === "paper_intent_created") {
    paperFillSimulation = await runCapitalPaperFillSimulation({
      repoRoot,
      intentsPath: path.join(outputDir, "capital-paper-intents.jsonl"),
      generatedCurrentIntentsPath: path.join(outputDir, "capital-paper-intents.jsonl"),
      outputPath: path.join(outputDir, "capital-paper-fill-simulation.json"),
    });
    paperEvaluation = await runCapitalPaperStrategyEvaluator({
      repoRoot,
      simulationPath: path.join(outputDir, "capital-paper-fill-simulation.json"),
      currentIntentsPath: path.join(outputDir, "capital-paper-intents.jsonl"),
      outputPath: path.join(outputDir, "capital-paper-strategy-evaluation.json"),
    });
  }

  report.learning.paperFillSimulation = paperFillSimulation
    ? {
        status: paperFillSimulation.status ?? "",
        sourceRecordCount: paperFillSimulation.source?.sourceRecordCount ?? 0,
        staleSource: false,
      }
    : {
        status: "",
        sourceRecordCount: 0,
        staleSource: false,
      };
  report.learning.paperEvaluation = paperEvaluation
    ? {
        status: paperEvaluation.status ?? "",
        recommendation: paperEvaluation.recommendation ?? "",
        staleSource: paperEvaluation.source?.staleSimulationSource === true,
        blockers: Array.isArray(paperEvaluation.blockers)
          ? paperEvaluation.blockers.map((blocker) => blocker.id).filter(Boolean)
          : [],
      }
    : {
        status: "",
        recommendation: "",
        staleSource: false,
        blockers: [],
      };

  // 自動審查：僅在有 paper intent 時嘗試晉升 candidate → approved_paper
  const autoReview = await runCapitalPaperAutoReview({
    repoRoot,
    writeState: trading.cycle.status === "paper_intent_created",
  }).catch(() => ({ status: "error", promoted: false, safetyChecks: { liveStillBlocked: true } }));
  report.learning.autoReview = {
    status: autoReview.status ?? "",
    promoted: autoReview.promoted,
    liveStillBlocked: autoReview.safetyChecks?.liveStillBlocked ?? true,
  };

  await writeJsonWithSha(reportPath, report);
  await appendJsonLine(streamPath, report);
  const assistantState = await runCapitalPaperAssistantState({
    repoRoot,
    writeState: true,
    silent: true,
  });
  await writeCapitalPaperAssistantState(
    assistantState.report,
    path.resolve(options.aliasAssistantStatePath || defaultAliasAssistantStatePath(repoRoot)),
  );
  return {
    pump,
    architectureReport,
    readinessReport,
    trading,
    report,
  };
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    stateDir: "",
    riskConfigPath: "",
    strategyPath: "",
    outputDir: "",
    architectureReportPath: "",
    readinessPath: "",
    reportPath: "",
    assistantStatePath: "",
    aliasAssistantStatePath: "",
    marketCode: "",
    maxQuoteAgeSeconds: undefined,
    json: false,
    requireIntent: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--state-dir") {
      options.stateDir = argv[++index] ?? options.stateDir;
    } else if (arg.startsWith("--state-dir=")) {
      options.stateDir = arg.slice("--state-dir=".length);
    } else if (arg === "--risk-config") {
      options.riskConfigPath = argv[++index] ?? options.riskConfigPath;
    } else if (arg.startsWith("--risk-config=")) {
      options.riskConfigPath = arg.slice("--risk-config=".length);
    } else if (arg === "--strategy") {
      options.strategyPath = argv[++index] ?? options.strategyPath;
    } else if (arg.startsWith("--strategy=")) {
      options.strategyPath = arg.slice("--strategy=".length);
    } else if (arg === "--output-dir") {
      options.outputDir = argv[++index] ?? options.outputDir;
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--architecture-report") {
      options.architectureReportPath = argv[++index] ?? options.architectureReportPath;
    } else if (arg.startsWith("--architecture-report=")) {
      options.architectureReportPath = arg.slice("--architecture-report=".length);
    } else if (arg === "--readiness") {
      options.readinessPath = argv[++index] ?? options.readinessPath;
    } else if (arg.startsWith("--readiness=")) {
      options.readinessPath = arg.slice("--readiness=".length);
    } else if (arg === "--report") {
      options.reportPath = argv[++index] ?? options.reportPath;
    } else if (arg.startsWith("--report=")) {
      options.reportPath = arg.slice("--report=".length);
    } else if (arg === "--assistant-state") {
      options.assistantStatePath = argv[++index] ?? options.assistantStatePath;
    } else if (arg.startsWith("--assistant-state=")) {
      options.assistantStatePath = arg.slice("--assistant-state=".length);
    } else if (arg === "--alias-assistant-state") {
      options.aliasAssistantStatePath = argv[++index] ?? options.aliasAssistantStatePath;
    } else if (arg.startsWith("--alias-assistant-state=")) {
      options.aliasAssistantStatePath = arg.slice("--alias-assistant-state=".length);
    } else if (arg === "--market-code") {
      options.marketCode = argv[++index] ?? options.marketCode;
    } else if (arg.startsWith("--market-code=")) {
      options.marketCode = arg.slice("--market-code=".length);
    } else if (arg === "--max-quote-age-seconds") {
      options.maxQuoteAgeSeconds = Number(argv[++index] ?? "");
    } else if (arg.startsWith("--max-quote-age-seconds=")) {
      options.maxQuoteAgeSeconds = Number(arg.slice("--max-quote-age-seconds=".length));
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--require-intent") {
      options.requireIntent = true;
    }
  }
  return options;
}

function formatSummary(report) {
  return [
    "OpenClaw Capital paper automation loop",
    `status=${report.status}`,
    `pump=${report.pump.status}`,
    `readiness=${report.readiness.status}`,
    `paperIntent=${report.trading.paperIntentId || "none"}`,
    `learning=${report.learning.status}`,
    `quote=${report.trading.quote.stockNo || "N/A"}/${report.trading.quote.close ?? "N/A"}`,
    `report=${report.files.reportPath}`,
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { report } = await runCapitalPaperAutomationLoop(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummary(report)}\n`);
  }
  if (options.requireIntent && !Object.is(report.trading.paperIntentCreated, true)) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital paper automation loop failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
