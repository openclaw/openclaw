#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "openclaw.capital.public-strategy-intake.v1";

const PUBLIC_SOURCES = [
  {
    id: "quantconnect-lean-engine",
    kind: "open_source_engine",
    trust: "official_docs",
    url: "https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/algorithm-engine",
    appliedIdea: "streaming/backtest parity and event-driven strategy validation",
  },
  {
    id: "backtrader-framework",
    kind: "open_source_backtester",
    trust: "official_docs",
    url: "https://www.backtrader.com/",
    appliedIdea: "reusable strategy, indicator, and analyzer structure",
  },
  {
    id: "freqtrade-strategy-customization",
    kind: "open_source_bot_docs",
    trust: "official_docs",
    url: "https://github.com/freqtrade/freqtrade/blob/develop/docs/strategy-customization.md",
    appliedIdea: "dry/live separation, pair locks, and explicit strategy templates",
  },
  {
    id: "quant-stackexchange-algorithmic-trading",
    kind: "discussion_forum",
    trust: "public_discussion",
    url: "https://quant.stackexchange.com/questions/tagged/algorithmic-trading",
    appliedIdea: "statistical rigor and intraday robustness questions before promotion",
  },
  {
    id: "reddit-algotrading-backtester-deployment-gap",
    kind: "discussion_forum",
    trust: "public_discussion",
    url: "https://www.reddit.com/r/algotrading/comments/1lo85gw",
    appliedIdea: "deployment gap guard between backtests and broker adapters",
  },
];

function parseArgs(argv) {
  return {
    repoRoot: valueAfter(argv, "--repo-root") ?? process.cwd(),
    json: argv.includes("--json"),
    writeState: argv.includes("--write-state"),
  };
}

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeText(filePath, text);
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function readJsonOptional(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readJsonlOptional(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function numberOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item);
    if (!key) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function signalFamily(strategy) {
  const value = String(strategy ?? "").toLowerCase();
  if (value.includes("vwap")) return "vwap_reversion";
  if (value.includes("orb") || value.includes("opening")) return "opening_range_breakout";
  if (value.includes("ema") || value.includes("trend")) return "trend_following";
  return value || "unknown";
}

function strategyFamilyCounts({ engine, intents }) {
  const engineSignals = Array.isArray(engine?.signals) ? engine.signals : [];
  if (engineSignals.length > 0) {
    return countBy(engineSignals, (signal) => signalFamily(signal.type));
  }
  return countBy(intents, (intent) => signalFamily(intent.strategy));
}

function deriveCandidates({ engine, intents, fillSimulation, tradeCycle }) {
  const families = strategyFamilyCounts({ engine, intents });
  const p05 = numberOr(fillSimulation?.monteCarlo?.p05_total_pnl_pts, 0);
  const p05Notional = numberOr(fillSimulation?.monteCarlo?.p05_total_pnl_notional, 0);
  const winRate = numberOr(fillSimulation?.monteCarlo?.win_rate, 0);
  const fillRate = numberOr(fillSimulation?.monteCarlo?.fill_rate, 0);
  const strategyFillGate = fillSimulation?.promotionGate?.status ?? "unknown";
  const cycleStatus = tradeCycle?.status ?? "unknown";
  const blockers = Array.isArray(tradeCycle?.blockers) ? tradeCycle.blockers : [];
  const candidates = [];

  if ((families.vwap_reversion ?? 0) > 0) {
    candidates.push({
      id: "quote_weighted_vwap_reversion",
      sourceBasis: ["backtrader-framework", "freqtrade-strategy-customization"],
      localEvidence: {
        signalFamily: "vwap_reversion",
        signalCount: families.vwap_reversion,
        monteCarloP05Pts: p05,
        monteCarloP05Notional: p05Notional,
        winRate,
        fillRate,
        strategyFillGate,
      },
      decision:
        p05 > 0 && strategyFillGate === "passed" ? "ready_for_paper_rerun" : "blocked_tail_risk",
      nextValidationCommand: "pnpm capital:strategy:fill-simulation:check",
      noOrderWrite: true,
      noLiveOrderSent: true,
    });
  }

  if ((families.opening_range_breakout ?? 0) > 0) {
    candidates.push({
      id: "opening_range_breakout_guarded",
      sourceBasis: ["quantconnect-lean-engine", "quant-stackexchange-algorithmic-trading"],
      localEvidence: {
        signalFamily: "opening_range_breakout",
        signalCount: families.opening_range_breakout,
        monteCarloP05Pts: p05,
        monteCarloP05Notional: p05Notional,
        strategyFillGate,
      },
      decision: p05 > 0 ? "ready_for_walk_forward_paper" : "blocked_until_positive_tail",
      nextValidationCommand: "pnpm capital:strategy:tail-risk-repair:check",
      noOrderWrite: true,
      noLiveOrderSent: true,
    });
  }

  candidates.push({
    id: "public_source_disciplined_strategy_loop",
    sourceBasis: PUBLIC_SOURCES.map((source) => source.id),
    localEvidence: {
      cycleStatus,
      blockerCount: blockers.length,
      primaryBlockers: blockers.slice(0, 6),
      activeIntentCount: intents.length,
    },
    decision: "ready_for_paper_research_only",
    nextValidationCommand: "pnpm capital:trade:auto-cycle:check",
    noOrderWrite: true,
    noLiveOrderSent: true,
  });

  return candidates;
}

function buildMarkdown(report) {
  const lines = [
    "# OpenClaw Capital Public Strategy Intake",
    "",
    `generatedAt: ${report.generatedAt}`,
    `status: ${report.status}`,
    `noOrderWrite: ${report.safety.noOrderWrite}`,
    "",
    "## Local Evidence",
    "",
    `- quoteSymbol: ${report.localEvidence.quoteSymbol}`,
    `- activeIntents: ${report.localEvidence.activeIntentCount}`,
    `- strategyFillGate: ${report.localEvidence.strategyFillGate}`,
    `- monteCarloP05Pts: ${report.localEvidence.monteCarloP05Pts}`,
    `- tradeAutoCycle: ${report.localEvidence.tradeAutoCycleStatus}`,
    "",
    "## Strategy Candidates",
    "",
  ];
  for (const candidate of report.strategyCandidates) {
    lines.push(
      `- ${candidate.id}: ${candidate.decision}; validate=${candidate.nextValidationCommand}; noOrderWrite=${candidate.noOrderWrite}`,
    );
  }
  lines.push("", "## Public Sources", "");
  for (const source of report.publicSources) {
    lines.push(`- ${source.id}: ${source.url}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runCapitalPublicStrategyIntake(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const enginePath = path.join(tradingRoot, "capital-strategy-engine-latest.json");
  const intentsPath = path.join(tradingRoot, "capital-strategy-intents.jsonl");
  const fillSimulationPath = path.join(tradingRoot, "capital-strategy-fill-simulation.json");
  const tradeCyclePath = path.join(stateRoot, "openclaw-capital-trade-auto-cycle-latest.json");
  const reportPath = path.join(stateRoot, "openclaw-capital-public-strategy-intake-latest.json");
  const markdownPath = path.join(stateRoot, "openclaw-capital-public-strategy-intake-latest.md");

  const engine = await readJsonOptional(enginePath, {});
  const intents = await readJsonlOptional(intentsPath);
  const fillSimulation = await readJsonOptional(fillSimulationPath, {});
  const tradeCycle = await readJsonOptional(tradeCyclePath, {});
  const families = strategyFamilyCounts({ engine, intents });
  const candidates = deriveCandidates({ engine, intents, fillSimulation, tradeCycle });
  const p05 = numberOr(fillSimulation?.monteCarlo?.p05_total_pnl_pts, 0);
  const p05Notional = numberOr(fillSimulation?.monteCarlo?.p05_total_pnl_notional, 0);
  const strategyFillGate = fillSimulation?.promotionGate?.status ?? "unknown";

  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    repoRoot,
    status:
      candidates.length > 0 ? "strategy_candidates_generated" : "blocked_no_local_quote_evidence",
    mode: "quote_simulation_public_source_strategy_intake",
    publicSources: PUBLIC_SOURCES,
    localEvidence: {
      engineStatus: engine?.status ?? "unknown",
      quoteSymbol: engine?.quoteSymbol ?? engine?.symbol ?? "",
      activeIntentCount: intents.length,
      signalFamilies: families,
      strategyFillGate,
      monteCarloP05Pts: p05,
      monteCarloP05Notional: p05Notional,
      tradeAutoCycleStatus: tradeCycle?.status ?? "unknown",
      tradeAutoCycleDecision: tradeCycle?.decision?.status ?? "unknown",
    },
    reasoningPolicy: {
      transformSourcesIntoStrategies: true,
      requireLocalQuoteEvidence: true,
      requireSimulationGateBeforePromotion: true,
      discussionSourcesAreHypothesisOnly: true,
      noExternalSourceCanAuthorizeLiveOrders: true,
    },
    strategyCandidates: candidates,
    safety: {
      paperOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
      noOrderWrite: true,
    },
    nextSafeTask:
      p05 > 0 && strategyFillGate === "passed"
        ? "rerun paper auto-review and platform gate before any human review"
        : "collect fresh resolved low-correlation candidates, then rerun capital:strategy:fill-simulation:check",
    sourceReports: {
      strategyEngine: enginePath,
      activeIntents: intentsPath,
      fillSimulation: fillSimulationPath,
      tradeAutoCycle: tradeCyclePath,
    },
    paths: {
      reportPath,
      markdownPath,
    },
  };

  if (options.writeState === true) {
    await writeJsonWithSha(reportPath, report);
    await writeText(markdownPath, buildMarkdown(report));
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runCapitalPublicStrategyIntake(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `CAPITAL_PUBLIC_STRATEGY_INTAKE=${report.status} candidates=${report.strategyCandidates.length} p05=${report.localEvidence.monteCarloP05Pts} strategyFillGate=${report.localEvidence.strategyFillGate} noOrderWrite=${report.safety.noOrderWrite}\n`,
  );
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
