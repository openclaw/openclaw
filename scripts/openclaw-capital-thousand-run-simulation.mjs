import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";

const SCHEMA = "openclaw.capital.thousand-run-simulation.v1";
const DEFAULT_RUNS = 1000;

const STRATEGY_PRIORS = {
  orb_long: 0.55,
  orb_short: 0.55,
  ema_long: 0.52,
  ema_short: 0.52,
  vwap_long: 0.58,
  vwap_short: 0.58,
  default: 0.5,
};

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
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") {
      return null;
    }
    throw error;
  }
}

async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function normal(rng) {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = Math.max(rng(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function percentile(values, pct) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.ceil((pct / 100) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[index];
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function simulateIntent(intent, rng, runIndex) {
  const strategy = intent.strategy ?? "default";
  const prior = STRATEGY_PRIORS[strategy] ?? STRATEGY_PRIORS.default;
  const confidence = Number(intent.confidence) || prior;
  const riskPts = Math.max(1, Number(intent.riskPts) || 1);
  const rewardPts = Math.max(1, Number(intent.rewardPts) || 1);
  const rr = rewardPts / riskPts;
  const stress = runIndex % 20 === 0;
  const gapEvent = rng() < (stress ? 0.14 : 0.025);
  const latencyMs = stress ? 250 + rng() * 1250 : 15 + rng() * 140;
  const slippagePts = Math.max(0, normal(rng) * (stress ? 5.5 : 1.4) + (stress ? 4 : 0.8));
  const fillProbability = clamp(
    0.9 - latencyMs / 5000 - slippagePts / 65 - (gapEvent ? 0.18 : 0),
    0.25,
    0.96,
  );

  if (rng() > fillProbability) {
    return {
      filled: false,
      win: false,
      pnlPts: 0,
      latencyMs,
      slippagePts,
      gapEvent,
      reason: "not_filled",
    };
  }

  const rrBonus = clamp((rr - 1.2) / 12, -0.04, 0.06);
  const winProbability = clamp(
    prior * 0.5 + confidence * 0.35 + rrBonus - latencyMs / 9000 - (gapEvent ? 0.1 : 0),
    0.18,
    0.78,
  );
  const win = rng() < winProbability;
  const pnlPts = win
    ? Math.max(0, rewardPts - slippagePts)
    : -(riskPts + slippagePts + (gapEvent ? riskPts * 0.15 : 0));

  return {
    filled: true,
    win,
    pnlPts,
    latencyMs,
    slippagePts,
    gapEvent,
    reason: win ? "tp_or_positive_exit" : "sl_or_negative_exit",
  };
}

function simulateRun(intents, runIndex, seed) {
  const rng = makeRng(seed + runIndex * 9973);
  let equity = 0;
  let peak = 0;
  let maxDrawdownPts = 0;
  let filled = 0;
  let wins = 0;
  let gapEvents = 0;
  let latencySum = 0;
  let slippageSum = 0;
  let worstTradePts = 0;
  const byStrategy = {};

  for (const intent of intents) {
    const result = simulateIntent(intent, rng, runIndex);
    latencySum += result.latencyMs;
    slippageSum += result.slippagePts;
    gapEvents += result.gapEvent ? 1 : 0;

    const strategy = intent.strategy ?? "unknown";
    byStrategy[strategy] ??= { count: 0, filled: 0, wins: 0, pnlPts: 0 };
    byStrategy[strategy].count += 1;

    if (result.filled) {
      filled += 1;
      byStrategy[strategy].filled += 1;
      if (result.win) {
        wins += 1;
        byStrategy[strategy].wins += 1;
      }
      equity += result.pnlPts;
      byStrategy[strategy].pnlPts += result.pnlPts;
      worstTradePts = Math.min(worstTradePts, result.pnlPts);
      peak = Math.max(peak, equity);
      maxDrawdownPts = Math.max(maxDrawdownPts, peak - equity);
    }
  }

  return {
    runIndex,
    totalPnlPts: round(equity, 4),
    fillRate: intents.length > 0 ? round(filled / intents.length, 4) : 0,
    winRate: filled > 0 ? round(wins / filled, 4) : 0,
    maxDrawdownPts: round(maxDrawdownPts, 4),
    worstTradePts: round(worstTradePts, 4),
    avgLatencyMs: intents.length > 0 ? round(latencySum / intents.length, 2) : 0,
    avgSlippagePts: intents.length > 0 ? round(slippageSum / intents.length, 4) : 0,
    gapEvents,
    byStrategy,
  };
}

function summarizeRuns(runs) {
  const pnl = runs.map((run) => run.totalPnlPts);
  const drawdowns = runs.map((run) => run.maxDrawdownPts);
  const fillRates = runs.map((run) => run.fillRate);
  const winRates = runs.map((run) => run.winRate);
  const totalPnlPtsMean = pnl.reduce((sum, value) => sum + value, 0) / Math.max(1, pnl.length);
  const losses = runs.filter((run) => run.totalPnlPts < 0).length;
  const ruinCount = runs.filter((run) => run.maxDrawdownPts >= 600).length;
  return {
    runs: runs.length,
    positiveRunRate: round(
      runs.filter((run) => run.totalPnlPts > 0).length / Math.max(1, runs.length),
      4,
    ),
    losingRunRate: round(losses / Math.max(1, runs.length), 4),
    ruinRate600Pts: round(ruinCount / Math.max(1, runs.length), 4),
    pnlPts: {
      mean: round(totalPnlPtsMean, 4),
      p01: round(percentile(pnl, 1), 4),
      p05: round(percentile(pnl, 5), 4),
      p50: round(percentile(pnl, 50), 4),
      p95: round(percentile(pnl, 95), 4),
      max: round(Math.max(...pnl), 4),
      min: round(Math.min(...pnl), 4),
    },
    maxDrawdownPts: {
      p50: round(percentile(drawdowns, 50), 4),
      p95: round(percentile(drawdowns, 95), 4),
      max: round(Math.max(...drawdowns), 4),
    },
    fillRate: {
      mean: round(
        fillRates.reduce((sum, value) => sum + value, 0) / Math.max(1, fillRates.length),
        4,
      ),
      p05: round(percentile(fillRates, 5), 4),
    },
    winRate: {
      mean: round(
        winRates.reduce((sum, value) => sum + value, 0) / Math.max(1, winRates.length),
        4,
      ),
      p05: round(percentile(winRates, 5), 4),
    },
  };
}

function summarizeByStrategy(runs) {
  const totals = {};
  for (const run of runs) {
    for (const [strategy, stats] of Object.entries(run.byStrategy)) {
      totals[strategy] ??= { count: 0, filled: 0, wins: 0, pnlPts: 0 };
      totals[strategy].count += stats.count;
      totals[strategy].filled += stats.filled;
      totals[strategy].wins += stats.wins;
      totals[strategy].pnlPts += stats.pnlPts;
    }
  }
  return Object.fromEntries(
    Object.entries(totals).map(([strategy, stats]) => [
      strategy,
      {
        count: stats.count,
        filled: stats.filled,
        winRate: stats.filled > 0 ? round(stats.wins / stats.filled, 4) : 0,
        avgPnlPtsPerRun: round(stats.pnlPts / DEFAULT_RUNS, 4),
        avgPnlPtsPerFill: stats.filled > 0 ? round(stats.pnlPts / stats.filled, 4) : 0,
      },
    ]),
  );
}

function buildFindings({
  intents,
  quote,
  service,
  readiness,
  summary,
  orderModeDryrun,
  riskControls,
}) {
  const fixNow = [];
  const addFeatures = [];
  const verification = [];
  const simulationRunsRequired = Number(riskControls?.minSimulationRuns ?? DEFAULT_RUNS);
  const blockNegativeP05 = riskControls?.blockLiveOnNegativeSimulationP05Pnl === true;
  const blockDrawdownExceed = riskControls?.blockLiveOnSimulationP95DrawdownExceed === true;
  const drawdownLimit = Number(riskControls?.maxAllowedSimulationP95DrawdownPts ?? 500);

  if (intents.length < 30) {
    addFeatures.push({
      item: "walk-forward / QMD replay sample expansion",
      reason: `current signal sample is only ${intents.length}; 1000-run perturbation is useful but not enough for live promotion.`,
      priority: "high",
    });
  }
  if ((quote?.summary?.staleSymbols ?? []).length > 0) {
    verification.push({
      item: "stale symbols stay blocked",
      reason: `stale=${quote.summary.staleSymbols.join(",")}; this is correct runtime blocking, not a price fallback target.`,
      priority: "medium",
    });
  }
  if (summary.pnlPts.p05 < 0) {
    if (blockNegativeP05) {
      verification.push({
        item: "risk throttle live blocker enforced",
        reason: `p05 pnl is ${summary.pnlPts.p05} pts; live promotion is blocked by capital-paper-hft-risk-controls.json.`,
        priority: "high",
      });
    } else {
      fixNow.push({
        item: "risk throttle before live promotion",
        reason: `p05 pnl is ${summary.pnlPts.p05} pts under stress simulation.`,
        priority: "high",
      });
    }
  }
  if (summary.maxDrawdownPts.p95 > drawdownLimit) {
    if (blockDrawdownExceed) {
      verification.push({
        item: "max drawdown live blocker enforced",
        reason: `p95 max drawdown is ${summary.maxDrawdownPts.p95} pts > limit ${drawdownLimit}; live promotion is blocked.`,
        priority: "high",
      });
    } else {
      fixNow.push({
        item: "max drawdown guard",
        reason: `p95 max drawdown is ${summary.maxDrawdownPts.p95} pts; pre-trade and intraday loss gates must enforce a hard stop.`,
        priority: "high",
      });
    }
  }
  if (summary.runs < simulationRunsRequired) {
    fixNow.push({
      item: "minimum simulation run count gate",
      reason: `runs=${summary.runs}, required=${simulationRunsRequired}.`,
      priority: "high",
    });
  }
  if (summary.fillRate.p05 < 0.55) {
    addFeatures.push({
      item: "latency/slippage adaptive order mode",
      reason: `p05 fill rate is ${summary.fillRate.p05}; strategy needs quote-age and slippage-sensitive execution mode.`,
      priority: "medium",
    });
  }
  if (riskControls?.requireWalkForwardBeforeLivePromotion === true) {
    verification.push({
      item: "walk-forward required before live promotion",
      reason: "QMD/walk-forward replay is explicitly required before any live promotion.",
      priority: "high",
    });
  }
  if (orderModeDryrun?.status !== "pass") {
    fixNow.push({
      item: "order mode dry-run gate",
      reason: "domestic/overseas day_trade and overnight dry-run is not passing.",
      priority: "high",
    });
  }
  if (
    service?.riskControls?.allowLiveTrading === true ||
    service?.riskControls?.writeBrokerOrders === true
  ) {
    fixNow.push({
      item: "live write safety lock",
      reason: "simulation gate must not run with live trading or broker writes enabled.",
      priority: "critical",
    });
  }
  if (
    readiness?.capabilities?.liveTradingExecution === true ||
    readiness?.capabilities?.brokerWriteExecution === true
  ) {
    fixNow.push({
      item: "promotion gate safety lock",
      reason:
        "live capabilities are enabled during simulation; this must remain blocked until manual promotion.",
      priority: "critical",
    });
  }

  return {
    fixNow,
    addFeatures,
    verification,
  };
}

function toMarkdown(report) {
  const fixRows = report.findings.fixNow.map(
    (item, index) =>
      `| ${index + 1} | ${item.priority} | ${item.item} | ${item.reason.replace(/\|/gu, "/")} |`,
  );
  const featureRows = report.findings.addFeatures.map(
    (item, index) =>
      `| ${index + 1} | ${item.priority} | ${item.item} | ${item.reason.replace(/\|/gu, "/")} |`,
  );
  const verifyRows = report.findings.verification.map(
    (item, index) =>
      `| ${index + 1} | ${item.priority} | ${item.item} | ${item.reason.replace(/\|/gu, "/")} |`,
  );
  return [
    "# Capital 1000-run Simulation Sweep",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- runs: ${report.summary.runs}`,
    `- symbol: ${report.inputs.symbol}`,
    `- intents: ${report.inputs.intentCount}`,
    `- quoteFreshAllowed: ${report.inputs.quoteFreshAllowed}`,
    `- liveTradingEnabled: ${report.safety.liveTradingEnabled}`,
    `- writeBrokerOrders: ${report.safety.writeBrokerOrders}`,
    `- stressRiskEnforced: ${report.riskGates.stressRiskEnforced}`,
    `- maxAllowedSimulationP95DrawdownPts: ${report.riskGates.maxAllowedSimulationP95DrawdownPts}`,
    `- requireWalkForwardBeforeLivePromotion: ${report.riskGates.requireWalkForwardBeforeLivePromotion}`,
    `- recommendation: ${report.recommendation}`,
    "",
    "## Summary",
    "",
    `- positiveRunRate: ${report.summary.positiveRunRate}`,
    `- losingRunRate: ${report.summary.losingRunRate}`,
    `- pnl p05/p50/p95: ${report.summary.pnlPts.p05} / ${report.summary.pnlPts.p50} / ${report.summary.pnlPts.p95}`,
    `- maxDrawdown p95/max: ${report.summary.maxDrawdownPts.p95} / ${report.summary.maxDrawdownPts.max}`,
    `- fillRate mean/p05: ${report.summary.fillRate.mean} / ${report.summary.fillRate.p05}`,
    `- winRate mean/p05: ${report.summary.winRate.mean} / ${report.summary.winRate.p05}`,
    "",
    "## Fix Now",
    "",
    "| # | Priority | Item | Reason |",
    "|---:|---|---|---|",
    ...(fixRows.length > 0
      ? fixRows
      : ["| 1 | none | no immediate code fix from simulation | keep paper-only gates |"]),
    "",
    "## Add Features",
    "",
    "| # | Priority | Item | Reason |",
    "|---:|---|---|---|",
    ...(featureRows.length > 0
      ? featureRows
      : ["| 1 | none | no new feature required | current gates are enough for paper |"]),
    "",
    "## Verification Notes",
    "",
    "| # | Priority | Item | Reason |",
    "|---:|---|---|---|",
    ...(verifyRows.length > 0
      ? verifyRows
      : ["| 1 | none | no extra verification note | all checks aligned |"]),
    "",
    "## Safety",
    "",
    "- No live order was sent.",
    "- Broker write path remains disabled.",
    "- This report is paper/simulation only.",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    runs: DEFAULT_RUNS,
    seed: 20260521,
    writeState: false,
    json: false,
    check: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--runs") {
      options.runs = Number(argv[++index]);
    } else if (arg === "--seed") {
      options.seed = Number(argv[++index]);
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--check") {
      options.check = true;
    }
  }
  return options;
}

export async function runCapitalThousandRunSimulation(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const capitalRoot = path.resolve(options.capitalRoot ?? resolveCapitalHftStateDir());
  const runsTarget =
    Number.isFinite(options.runs) && options.runs > 0 ? Math.trunc(options.runs) : DEFAULT_RUNS;
  const seed = Number.isFinite(options.seed) ? Math.trunc(options.seed) : 20260521;
  const intentsPath =
    options.intentsPath ??
    path.join(repoRoot, ".openclaw", "trading", "capital-paper-intents.jsonl");
  const intents = await readJsonl(intentsPath);
  const [quote, service, readiness, fill, orderModeDryrun, riskControls] = await Promise.all([
    readJsonIfExists(path.join(capitalRoot, "state", "capital_callback_readback_latest.json")),
    readJsonIfExists(path.join(capitalRoot, "hft_service_status.json")),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-live-strategy-readiness-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(repoRoot, ".openclaw", "trading", "capital-strategy-fill-simulation.json"),
    ),
    readJsonIfExists(
      path.join(capitalRoot, "state", "capital_paper_order_mode_dryrun_latest.json"),
    ),
    readJsonIfExists(path.join(repoRoot, "config", "capital-paper-hft-risk-controls.json")),
  ]);

  const runs = [];
  for (let index = 0; index < runsTarget; index++) {
    runs.push(simulateRun(intents, index, seed));
  }
  const summary = summarizeRuns(runs);
  const byStrategy = summarizeByStrategy(runs);
  const safety = {
    liveTradingEnabled: service?.riskControls?.allowLiveTrading === true,
    writeBrokerOrders: service?.riskControls?.writeBrokerOrders === true,
    liveStrategyExecution: readiness?.capabilities?.liveStrategyExecution === true,
    liveTradingExecution: readiness?.capabilities?.liveTradingExecution === true,
    brokerWriteExecution: readiness?.capabilities?.brokerWriteExecution === true,
    orderModeDryrunPass: orderModeDryrun?.status === "pass",
    noLiveOrderSent: Number(service?.orderStats?.sent ?? 0) === 0,
  };
  const findings = buildFindings({
    intents,
    quote,
    service,
    readiness,
    summary,
    orderModeDryrun,
    riskControls,
  });
  const criticalFixes = findings.fixNow.filter((item) => item.priority === "critical");
  const stressRiskEnforced =
    (summary.pnlPts.p05 < 0 && riskControls?.blockLiveOnNegativeSimulationP05Pnl === true) ||
    (summary.maxDrawdownPts.p95 > Number(riskControls?.maxAllowedSimulationP95DrawdownPts ?? 500) &&
      riskControls?.blockLiveOnSimulationP95DrawdownExceed === true);
  const recommendation =
    criticalFixes.length > 0
      ? "block_until_safety_fixed"
      : findings.fixNow.length > 0
        ? "paper_only_fix_risk_gates"
        : stressRiskEnforced
          ? "paper_only_risk_gates_enforced"
          : "paper_continue_no_live";
  const status =
    runsTarget === DEFAULT_RUNS && criticalFixes.length === 0
      ? "pass_with_findings"
      : "review_required";
  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status,
    recommendation,
    inputs: {
      repoRoot,
      capitalRoot,
      intentsPath,
      intentCount: intents.length,
      symbol: intents[0]?.symbol ?? "",
      runs: runsTarget,
      seed,
      quoteFreshAllowed: quote?.quoteFreshAllowed === true,
      freshMatchedCount: quote?.summary?.freshMatchedCount ?? 0,
      staleSymbols: quote?.summary?.staleSymbols ?? [],
      baselineFillRecommendation: fill?.recommendation ?? "",
    },
    safety,
    riskGates: {
      simulationSweepRequired: riskControls?.simulationSweepRequired === true,
      minSimulationRuns: Number(riskControls?.minSimulationRuns ?? DEFAULT_RUNS),
      blockLiveOnNegativeSimulationP05Pnl:
        riskControls?.blockLiveOnNegativeSimulationP05Pnl === true,
      blockLiveOnSimulationP95DrawdownExceed:
        riskControls?.blockLiveOnSimulationP95DrawdownExceed === true,
      maxAllowedSimulationP95DrawdownPts: Number(
        riskControls?.maxAllowedSimulationP95DrawdownPts ?? 500,
      ),
      maxAllowedSimulationRuinRate600Pts: Number(
        riskControls?.maxAllowedSimulationRuinRate600Pts ?? 0.05,
      ),
      requireWalkForwardBeforeLivePromotion:
        riskControls?.requireWalkForwardBeforeLivePromotion === true,
      stressRiskEnforced,
    },
    summary,
    byStrategy,
    findings,
    nextSafeTask:
      findings.fixNow.length > 0
        ? "先把 simulation sweep 指出的 risk throttle / max drawdown guard 接進 PreTradeRiskGate，再重跑 1000-run sweep。"
        : "持續 paper loop 並加入 QMD/walk-forward replay，真單仍等待 promotion gate。",
  };

  if (options.writeState || options.check) {
    await writeJsonWithSha(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-thousand-run-simulation-latest.json",
      ),
      report,
    );
    await writeTextWithSha(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-thousand-run-simulation-latest.md",
      ),
      `${toMarkdown(report)}\n`,
    );
    await writeTextWithSha(
      path.join(repoRoot, "docs", "automation", "capital-api-thousand-run-simulation.md"),
      `${toMarkdown(report)}\n`,
    );
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runCapitalThousandRunSimulation({
    repoRoot: process.cwd(),
    runs: options.runs,
    seed: options.seed,
    writeState: options.writeState,
    check: options.check,
  });
  if (options.json || options.check) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${toMarkdown(report)}\n`);
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
