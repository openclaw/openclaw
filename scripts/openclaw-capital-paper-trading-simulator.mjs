import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCapitalPaperLearningSummaryReport,
  writeCapitalPaperLearningSummaryReport,
} from "./openclaw-capital-paper-learning-summary.mjs";

function defaultReadinessPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-hft-readiness.json");
}

function defaultQuoteStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-quote-state.json");
}

function defaultStrategyPath(repoRoot) {
  return path.join(repoRoot, "config", "capital-paper-microstructure-strategy.json");
}

function defaultOutputDir(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading");
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

function stringOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseDecimal(quote) {
  const direct = numberOr(quote?.decimal, Number.NaN);
  if (Number.isFinite(direct)) {
    return direct;
  }
  const match = stringOr(quote?.message).match(/\bdecimal=(\d+)\b/);
  return match ? Number(match[1]) : 0;
}

function scaledQuoteNumber(value, decimal) {
  const numeric = numberOr(value, Number.NaN);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric / 10 ** decimal;
}

function normalizeQuote(quoteState) {
  const quote = quoteState?.quote ?? {};
  const decimal = parseDecimal(quote);
  const close = scaledQuoteNumber(quote.close, decimal);
  const bid = scaledQuoteNumber(quote.bid, decimal);
  const ask = scaledQuoteNumber(quote.ask, decimal);
  const qty = numberOr(quote.qty, 0);
  return {
    eventSource: stringOr(quote.eventSource),
    receivedAt: stringOr(quote.receivedAt),
    stockNo: stringOr(quote.stockNo),
    stockName: stringOr(quote.stockName),
    decimal,
    close,
    bid,
    ask,
    qty,
    raw: {
      close: stringOr(quote.close),
      bid: stringOr(quote.bid),
      ask: stringOr(quote.ask),
      qty: stringOr(quote.qty),
      message: stringOr(quote.message),
    },
  };
}

function orderablePaperSymbol(stockNo) {
  const normalized = stringOr(stockNo).trim().toUpperCase();
  const txSessionAlias = normalized.match(/^(TX\d{2})(?:AM|PM)$/u);
  return txSessionAlias?.[1] ?? normalized;
}

function nowIso() {
  return new Date().toISOString();
}

function buildBaseLearningRegistry(strategy) {
  return {
    schema: "openclaw.capital.paper-learning-registry.v1",
    generatedAt: nowIso(),
    strategyName: strategy.strategyName,
    status: "candidate",
    liveEligible: false,
    paperEligible: false,
    counters: {
      totalCycles: 0,
      paperIntents: 0,
      readinessBlocks: 0,
      quoteBlocks: 0,
      consecutiveReadinessBlocks: 0,
      consecutiveReadyCycles: 0,
    },
    lastObservation: {},
    rules: strategy.learning ?? {},
  };
}

function updateLearningRegistry(previous, cycle, strategy) {
  const registry = {
    ...buildBaseLearningRegistry(strategy),
    ...previous,
    generatedAt: nowIso(),
    strategyName: strategy.strategyName,
    liveEligible: false,
  };
  const counters = {
    ...buildBaseLearningRegistry(strategy).counters,
    ...previous?.counters,
  };
  counters.totalCycles += 1;

  if (cycle.status === "paper_intent_created") {
    counters.paperIntents += 1;
    counters.consecutiveReadyCycles += 1;
    counters.consecutiveReadinessBlocks = 0;
  } else if (cycle.status === "blocked_readiness") {
    counters.readinessBlocks += 1;
    counters.consecutiveReadinessBlocks += 1;
    counters.consecutiveReadyCycles = 0;
  } else {
    counters.quoteBlocks += 1;
    counters.consecutiveReadyCycles = 0;
  }

  const minReadyCycles = numberOr(strategy.learning?.minReadyCyclesForPaper, 20);
  const blockAfterReadiness = numberOr(strategy.learning?.blockAfterConsecutiveReadinessBlocks, 20);
  let status = "candidate";
  let paperEligible = false;
  if (counters.consecutiveReadinessBlocks >= blockAfterReadiness) {
    status = "blocked";
  } else if (counters.consecutiveReadyCycles >= minReadyCycles) {
    status = "approved_paper";
    paperEligible = true;
  }

  return {
    ...registry,
    status,
    paperEligible,
    counters,
    lastObservation: {
      generatedAt: cycle.generatedAt,
      cycleId: cycle.cycleId,
      status: cycle.status,
      reason: cycle.reason,
      latestStock: cycle.quote.stockNo,
      latestBid: cycle.quote.bid,
      latestAsk: cycle.quote.ask,
      quoteAgeSeconds: cycle.readiness.summary.quoteAgeSeconds,
      paperIntentId: cycle.paperIntent?.intentId ?? "",
      executionPlan: cycle.execution,
    },
    rules: strategy.learning ?? {},
  };
}

function createCycleId(generatedAt, quote) {
  return `capital-paper-${sha256Text(`${generatedAt}|${quote.stockNo}|${quote.raw.close}|${quote.raw.bid}|${quote.raw.ask}`).slice(0, 16)}`;
}

function buildPaperIntent({ cycleId, generatedAt, quote, strategy }) {
  const bid = quote.bid;
  const ask = quote.ask;
  const symbol = orderablePaperSymbol(quote.stockNo);
  const spread = bid != null && ask != null ? ask - bid : Number.POSITIVE_INFINITY;
  const maxSpread = numberOr(strategy.maxSpreadTicks, 0) * numberOr(strategy.tickSize, 1);
  const validBidAsk = bid != null && ask != null && bid > 0 && ask > 0 && ask >= bid;
  if (strategy.requirePositiveBidAsk === true && !validBidAsk) {
    return {
      status: "blocked_quote",
      reason: "bid/ask 不可用；不能產生真實報價擬態 paper limit intent。",
      paperIntent: null,
    };
  }
  if (spread > maxSpread) {
    return {
      status: "blocked_quote",
      reason: "spread 超過 paper microstructure 風控上限。",
      paperIntent: null,
    };
  }

  return {
    status: "paper_intent_created",
    reason: "使用真實 bid/ask 建立 paper-only passive bid intent。",
    paperIntent: {
      schema: "openclaw.capital.paper-intent.v1",
      intentId: `${cycleId}-intent`,
      generatedAt,
      mode: "paper",
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      brokerOrderPathEnabled: false,
      provider: "capital",
      strategyName: strategy.strategyName,
      symbol,
      symbolName: quote.stockName,
      side: "buy",
      orderType: "paper_limit",
      price: bid,
      quantity: numberOr(strategy.quantity, 1),
      ttlMs: numberOr(strategy.intentTtlMs, 750),
      sourceEvent: {
        eventSource: quote.eventSource,
        receivedAt: quote.receivedAt,
        stockNo: quote.stockNo,
        orderableSymbol: symbol,
        close: quote.close,
        bid,
        ask,
        qty: quote.qty,
      },
      status: "pending_paper_fill",
    },
  };
}

function buildExecutionPlan({ quote, strategy, paperIntent, readiness }) {
  const entryStyle = stringOr(strategy?.signalPolicy, "passive_bid_probe");
  const freshQuoteReady = readiness?.ready === true && quote.bid != null && quote.ask != null;
  const entryAction = paperIntent != null ? "place_paper_limit_buy" : "wait_for_fresh_quote";
  const exitAction =
    paperIntent != null ? "monitor_fill_then_place_paper_limit_sell" : "wait_for_fresh_quote";
  return {
    schema: "openclaw.capital.paper-execution-plan.v1",
    generatedAt: nowIso(),
    mode: "paper",
    readOnlyQuoteOnly: true,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    strategyName: strategy.strategyName,
    signalPolicy: entryStyle,
    status: paperIntent != null ? "paper_intent_created" : "waiting_quote",
    entry: {
      side: "buy",
      style: entryStyle,
      trigger: "fresh quote + bid/ask > 0 + spread within maxSpreadTicks",
      referencePrice: "bid",
      action: entryAction,
      price: quote.bid,
      priceLabel: "bid",
      ready: freshQuoteReady,
    },
    exit: {
      side: "sell",
      style: "passive_ask_probe",
      trigger: "paper fill or risk exit after entry",
      referencePrice: "ask",
      action: exitAction,
      price: quote.ask,
      priceLabel: "ask",
      ready: freshQuoteReady && paperIntent != null,
    },
    actionSummary:
      paperIntent != null
        ? "以 bid 進場、以 ask 規劃出場，僅限 paper-only 模擬。"
        : "等待新的即時報價與可用 bid/ask 後，再產生買入與賣出動作。",
    paperIntentCreated: paperIntent != null,
  };
}

export function buildCapitalPaperTradingCycle(inputs) {
  const { readiness, quoteState, strategy, previousLearning = {} } = inputs;
  const generatedAt = nowIso();
  const quote = normalizeQuote(quoteState);
  const cycleId = createCycleId(generatedAt, quote);

  let status = "blocked_readiness";
  let reason = "paper HFT readiness gate 未通過；不產生交易擬態 intent。";
  let paperIntent = null;

  if (strategy?.enabled !== true) {
    status = "blocked_strategy";
    reason = "paper microstructure strategy disabled.";
  } else if (
    strategy.allowLiveTrading !== false ||
    strategy.writeBrokerOrders !== false ||
    readiness?.liveTradingEnabled !== false ||
    readiness?.writeTradingEnabled !== false ||
    readiness?.brokerOrderPathEnabled !== false
  ) {
    status = "blocked_live_path";
    reason = "live trading or broker write path is not locked.";
  } else if (readiness?.ready === true) {
    const decision = buildPaperIntent({ cycleId, generatedAt, quote, strategy });
    status = decision.status;
    reason = decision.reason;
    paperIntent = decision.paperIntent;
  }
  const executionPlan = buildExecutionPlan({ quote, strategy, paperIntent, readiness });

  const cycle = {
    schema: "openclaw.capital.paper-trading-cycle.v1",
    generatedAt,
    cycleId,
    status,
    reason,
    mode: "paper",
    readOnlyQuoteOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    strategy: {
      strategyName: strategy.strategyName,
      signalPolicy: strategy.signalPolicy,
      learningStatus: previousLearning?.status ?? "candidate",
    },
    execution: executionPlan,
    readiness: {
      status: readiness?.status ?? "",
      ready: readiness?.ready === true,
      summary: readiness?.summary ?? {},
    },
    quote,
    paperIntent,
    learningEvent: {
      schema: "openclaw.capital.paper-learning-event.v1",
      generatedAt,
      cycleId,
      strategyName: strategy.strategyName,
      status,
      reason,
      quoteAgeSeconds: readiness?.summary?.quoteAgeSeconds ?? -1,
      paperIntentCreated: paperIntent != null,
      executionPlan,
    },
  };
  return {
    cycle,
    learningRegistry: updateLearningRegistry(previousLearning, cycle, strategy),
  };
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

export async function writeCapitalPaperTradingCycle(outputs, outputDir) {
  const latestCyclePath = path.join(outputDir, "capital-paper-trading-cycle-latest.json");
  const cycleStreamPath = path.join(outputDir, "capital-paper-trading-cycles.jsonl");
  const latestIntentPath = path.join(outputDir, "capital-paper-intent-latest.json");
  const intentStreamPath = path.join(outputDir, "capital-paper-intents.jsonl");
  const learningRegistryPath = path.join(outputDir, "capital-paper-learning-registry.json");
  const learningStreamPath = path.join(outputDir, "capital-paper-learning-events.jsonl");
  const learningSummaryPath = path.join(outputDir, "capital-paper-learning-summary.json");

  await writeJsonWithSha(latestCyclePath, outputs.cycle);
  await appendJsonLine(cycleStreamPath, outputs.cycle);
  if (outputs.cycle.paperIntent) {
    await writeJsonWithSha(latestIntentPath, outputs.cycle.paperIntent);
    await appendJsonLine(intentStreamPath, outputs.cycle.paperIntent);
  }
  await writeJsonWithSha(learningRegistryPath, outputs.learningRegistry);
  await appendJsonLine(learningStreamPath, outputs.cycle.learningEvent);
  const learningSummary = buildCapitalPaperLearningSummaryReport({
    registry: outputs.learningRegistry,
    registryPath: learningRegistryPath,
    reportPath: learningSummaryPath,
  });
  await writeCapitalPaperLearningSummaryReport(learningSummary, learningSummaryPath);

  return {
    latestCyclePath,
    cycleStreamPath,
    latestIntentPath: outputs.cycle.paperIntent ? latestIntentPath : "",
    intentStreamPath: outputs.cycle.paperIntent ? intentStreamPath : "",
    learningRegistryPath,
    learningStreamPath,
    learningSummaryPath,
  };
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    readinessPath: "",
    quoteStatePath: "",
    strategyPath: "",
    outputDir: "",
    writeState: false,
    json: false,
    requireIntent: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--readiness") {
      options.readinessPath = argv[++index] ?? options.readinessPath;
    } else if (arg.startsWith("--readiness=")) {
      options.readinessPath = arg.slice("--readiness=".length);
    } else if (arg === "--quote-state") {
      options.quoteStatePath = argv[++index] ?? options.quoteStatePath;
    } else if (arg.startsWith("--quote-state=")) {
      options.quoteStatePath = arg.slice("--quote-state=".length);
    } else if (arg === "--strategy") {
      options.strategyPath = argv[++index] ?? options.strategyPath;
    } else if (arg.startsWith("--strategy=")) {
      options.strategyPath = arg.slice("--strategy=".length);
    } else if (arg === "--output-dir") {
      options.outputDir = argv[++index] ?? options.outputDir;
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--require-intent") {
      options.requireIntent = true;
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot);
  const outputDir = path.resolve(options.outputDir || defaultOutputDir(repoRoot));
  const learningRegistryPath = path.join(outputDir, "capital-paper-learning-registry.json");
  const [readiness, quoteState, strategy, previousLearning] = await Promise.all([
    readJson(
      path.resolve(options.readinessPath || defaultReadinessPath(repoRoot)),
      "Capital paper HFT readiness",
    ),
    readJson(
      path.resolve(options.quoteStatePath || defaultQuoteStatePath(repoRoot)),
      "Capital quote state",
    ),
    readJson(
      path.resolve(options.strategyPath || defaultStrategyPath(repoRoot)),
      "Capital paper microstructure strategy",
    ),
    readOptionalJson(learningRegistryPath, {}),
  ]);

  const outputs = buildCapitalPaperTradingCycle({
    readiness,
    quoteState,
    strategy,
    previousLearning,
  });
  const files = options.writeState ? await writeCapitalPaperTradingCycle(outputs, outputDir) : {};
  const result = { ...outputs.cycle, learningRegistry: outputs.learningRegistry, files };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital paper trading simulator",
        `status=${outputs.cycle.status}`,
        `paperIntent=${outputs.cycle.paperIntent ? outputs.cycle.paperIntent.intentId : "none"}`,
        `learningStatus=${outputs.learningRegistry.status}`,
        `quote=${outputs.cycle.quote.stockNo}/${outputs.cycle.quote.close ?? "N/A"}`,
      ].join("\n") + "\n",
    );
  }

  if (options.requireIntent && !outputs.cycle.paperIntent) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital paper trading simulator failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
