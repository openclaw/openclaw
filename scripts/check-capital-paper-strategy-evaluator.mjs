#!/usr/bin/env node
// check-capital-paper-strategy-evaluator.mjs — gate check for strategy evaluator
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCapitalPaperStrategyEvaluator } from "./openclaw-capital-paper-strategy-evaluator.mjs";

async function assertSourceIntegrityBlocksPromotion() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-paper-eval-"));
  const simulationPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-fill-simulation.json",
  );
  const outputPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-strategy-evaluation.json",
  );
  await fs.mkdir(path.dirname(simulationPath), { recursive: true });
  await fs.writeFile(
    simulationPath,
    `${JSON.stringify({
      schema: "openclaw.capital.paper-fill-simulation.v1",
      status: "ok",
      readOnly: true,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      brokerOrderPathEnabled: false,
      safetyLock: {
        allowLiveTrading: false,
        writeBrokerOrders: false,
        promoteLiveAutomatically: false,
      },
      stats: {
        total_intents: 7,
        filled_count: 7,
        fill_rate: 1,
        avg_pnl_ticks: 8,
        total_pnl_ticks: 56,
        sharpe_proxy: 1.2,
        win_streak_max: 7,
        loss_streak_max: 0,
        invalid_intent_count: 0,
        unsafe_intent_count: 0,
        blocked_legacy_alias_count: 0,
        normalized_legacy_alias_count: 1,
      },
      monteCarlo: {
        iterations: 500,
        positive_rate: 0.99,
      },
    })}\n`,
    "utf8",
  );
  const integrityResult = await runCapitalPaperStrategyEvaluator({
    repoRoot: tempRoot,
    simulationPath,
    outputPath,
  });
  if (integrityResult.recommendation !== "reject") {
    throw new Error(`Source integrity breach must reject: ${JSON.stringify(integrityResult)}`);
  }
  if (!integrityResult.failedRules?.some((rule) => rule.id === "rule_source_integrity")) {
    throw new Error(
      `Source integrity failure missing from failedRules: ${JSON.stringify(integrityResult.failedRules)}`,
    );
  }
}

async function assertStrategySnapshotBlocksPromotion() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-paper-eval-snapshot-"));
  const simulationPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-fill-simulation.json",
  );
  const strategyFillSimulationPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-strategy-fill-simulation.json",
  );
  const outputPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-strategy-evaluation.json",
  );
  await fs.mkdir(path.dirname(simulationPath), { recursive: true });
  await fs.writeFile(
    simulationPath,
    `${JSON.stringify({
      schema: "openclaw.capital.paper-fill-simulation.v1",
      status: "no_intents",
      readOnly: true,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      brokerOrderPathEnabled: false,
      safetyLock: {
        allowLiveTrading: false,
        writeBrokerOrders: false,
        promoteLiveAutomatically: false,
      },
      stats: {
        total_intents: 0,
        filled_count: 0,
        fill_rate: 0,
        avg_pnl_ticks: 0,
        total_pnl_ticks: 0,
        sharpe_proxy: 0,
        win_streak_max: 0,
        loss_streak_max: 0,
        invalid_intent_count: 0,
        unsafe_intent_count: 0,
        blocked_legacy_alias_count: 0,
        normalized_legacy_alias_count: 0,
      },
      monteCarlo: {
        iterations: 500,
        positive_rate: 0,
      },
    })}\n`,
    "utf8",
  );
  await fs.writeFile(
    strategyFillSimulationPath,
    `${JSON.stringify({
      schema: "openclaw.capital.strategy-fill-simulation.v1",
      status: "historical_simulated",
      recommendation: "hold",
      source: {
        simulationMode: "historical_snapshot",
      },
      stats: {
        total_intents: 7,
        filled_count: 6,
      },
      safetyLock: {
        executionEligible: false,
        promotionBlocked: true,
      },
    })}\n`,
    "utf8",
  );

  const snapshotResult = await runCapitalPaperStrategyEvaluator({
    repoRoot: tempRoot,
    simulationPath,
    strategyFillSimulationPath,
    outputPath,
  });
  if (snapshotResult.recommendation !== "reject") {
    throw new Error(
      `Historical strategy snapshot must not promote: ${JSON.stringify(snapshotResult)}`,
    );
  }
  if (!snapshotResult.blockers?.some((blocker) => blocker.id === "strategy_snapshot_only")) {
    throw new Error(
      `Historical strategy snapshot blocker missing: ${JSON.stringify(snapshotResult.blockers)}`,
    );
  }
  if (snapshotResult.safetyLock?.strategySnapshotOnly !== true) {
    throw new Error(
      `Historical strategy snapshot safety lock missing: ${JSON.stringify(snapshotResult.safetyLock)}`,
    );
  }
}

async function assertStaleFillSourceBlocksPromotion() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-paper-eval-stale-"));
  const currentIntentsPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-intents.jsonl",
  );
  const simulationPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-fill-simulation.json",
  );
  const outputPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-strategy-evaluation.json",
  );
  await fs.mkdir(path.dirname(simulationPath), { recursive: true });
  await fs.writeFile(currentIntentsPath, "", "utf8");
  await fs.writeFile(
    simulationPath,
    `${JSON.stringify({
      schema: "openclaw.capital.paper-fill-simulation.v1",
      status: "ok",
      readOnly: true,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      brokerOrderPathEnabled: false,
      source: {
        intentsPath: currentIntentsPath,
        actualPath: currentIntentsPath,
        fallbackUsed: false,
      },
      safetyLock: {
        allowLiveTrading: false,
        writeBrokerOrders: false,
        promoteLiveAutomatically: false,
      },
      stats: {
        total_intents: 12,
        filled_count: 12,
        fill_rate: 1,
        avg_pnl_ticks: 7.5,
        total_pnl_ticks: 90,
        sharpe_proxy: 1.5,
        win_streak_max: 12,
        loss_streak_max: 0,
        invalid_intent_count: 0,
        unsafe_intent_count: 0,
        blocked_legacy_alias_count: 0,
        normalized_legacy_alias_count: 0,
      },
      monteCarlo: {
        iterations: 500,
        positive_rate: 1,
      },
    })}\n`,
    "utf8",
  );

  const staleResult = await runCapitalPaperStrategyEvaluator({
    repoRoot: tempRoot,
    simulationPath,
    currentIntentsPath,
    outputPath,
  });
  if (staleResult.recommendation !== "reject") {
    throw new Error(`Stale fill source must reject: ${JSON.stringify(staleResult)}`);
  }
  if (
    !staleResult.blockers?.some((blocker) => blocker.id === "stale_fill_simulation_source_empty")
  ) {
    throw new Error(`Stale fill source blocker missing: ${JSON.stringify(staleResult.blockers)}`);
  }
  if (staleResult.safetyLock?.staleSimulationSource !== true) {
    throw new Error(
      `Stale fill source safety lock missing: ${JSON.stringify(staleResult.safetyLock)}`,
    );
  }
}

async function assertStaleFillDigestBlocksPromotion() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-paper-eval-digest-"));
  const currentIntentsPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-intents.jsonl",
  );
  const simulationPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-fill-simulation.json",
  );
  const outputPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-strategy-evaluation.json",
  );
  await fs.mkdir(path.dirname(simulationPath), { recursive: true });
  await fs.writeFile(
    currentIntentsPath,
    `${JSON.stringify({
      schema: "openclaw.capital.paper-intent.v2",
      intentId: "current-different-intent",
      intentRunId: "current-run",
      symbol: "TX00",
      paperOnly: true,
      allowLiveTrading: false,
      writeBrokerOrders: false,
    })}\n`,
    "utf8",
  );
  await fs.writeFile(
    simulationPath,
    `${JSON.stringify({
      schema: "openclaw.capital.paper-fill-simulation.v1",
      status: "ok",
      readOnly: true,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      brokerOrderPathEnabled: false,
      source: {
        intentsPath: currentIntentsPath,
        actualPath: currentIntentsPath,
        fallbackUsed: false,
        sourceRecordCount: 1,
        sourceDigest: "0".repeat(64),
      },
      safetyLock: {
        allowLiveTrading: false,
        writeBrokerOrders: false,
        promoteLiveAutomatically: false,
      },
      stats: {
        total_intents: 1,
        filled_count: 1,
        fill_rate: 1,
        avg_pnl_ticks: 8,
        total_pnl_ticks: 8,
        sharpe_proxy: 1,
        win_streak_max: 1,
        loss_streak_max: 0,
        invalid_intent_count: 0,
        unsafe_intent_count: 0,
        blocked_legacy_alias_count: 0,
        normalized_legacy_alias_count: 0,
      },
      monteCarlo: {
        iterations: 500,
        positive_rate: 1,
      },
    })}\n`,
    "utf8",
  );

  const digestResult = await runCapitalPaperStrategyEvaluator({
    repoRoot: tempRoot,
    simulationPath,
    currentIntentsPath,
    outputPath,
  });
  if (digestResult.recommendation !== "reject") {
    throw new Error(`Digest mismatch must reject: ${JSON.stringify(digestResult)}`);
  }
  if (digestResult.safetyLock?.staleSimulationDigestMismatch !== true) {
    throw new Error(
      `Digest mismatch safety lock missing: ${JSON.stringify(digestResult.safetyLock)}`,
    );
  }
}

await assertSourceIntegrityBlocksPromotion();
await assertStrategySnapshotBlocksPromotion();
await assertStaleFillSourceBlocksPromotion();
await assertStaleFillDigestBlocksPromotion();

const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-paper-eval-live-probe-"));
const result = await runCapitalPaperStrategyEvaluator({
  repoRoot: process.cwd(),
  outputPath: path.join(probeRoot, "capital-paper-strategy-evaluation.json"),
});

if (!result.schema?.startsWith("openclaw.capital.paper-strategy-evaluation")) {
  throw new Error(`Strategy evaluator returned unexpected schema: ${result.schema}`);
}

// no_simulation is acceptable (fill-sim hasn't run yet)
if (result.status === "no_simulation") {
  process.stdout.write("CAPITAL_PAPER_STRATEGY_EVALUATOR_CHECK=OK (no_simulation)\n");
  process.exit(0);
}

// Must have recommendation field
if (!["promote", "review", "reject"].includes(result.recommendation)) {
  throw new Error(
    `Strategy evaluator returned unexpected recommendation: ${result.recommendation}`,
  );
}

// Must have passCount
if (typeof result.passCount !== "number") {
  throw new Error(`Strategy evaluator missing passCount: ${JSON.stringify(result)}`);
}
if (result.readOnly !== true || result.loginAttempted !== false) {
  throw new Error("Strategy evaluator must stay read-only and must not login");
}
if (
  result.liveTradingEnabled !== false ||
  result.writeTradingEnabled !== false ||
  result.brokerOrderPathEnabled !== false
) {
  throw new Error("Strategy evaluator enabled a live/write broker flag");
}
if (
  result.safetyLock?.allowLiveTrading !== false ||
  result.safetyLock?.writeBrokerOrders !== false
) {
  throw new Error(`Strategy evaluator safety lock malformed: ${JSON.stringify(result.safetyLock)}`);
}
if (!Number.isInteger(result.ruleCount) || result.ruleCount < 7) {
  throw new Error(
    `Strategy evaluator must check the full rule set: ${JSON.stringify(result.rules)}`,
  );
}
if (result.rules?.rule_source_integrity?.pass !== true) {
  throw new Error(
    `Strategy evaluator source integrity failed: ${JSON.stringify(result.rules?.rule_source_integrity)}`,
  );
}
if (!result.summary) {
  throw new Error("Strategy evaluator needs summary evidence");
}
if (result.summary.total_intents <= 0) {
  if (result.recommendation !== "reject") {
    throw new Error(
      `Strategy evaluator cannot pass empty intent evidence: ${JSON.stringify(result.summary)}`,
    );
  }
  if (result.summary.strategy_fill_total_intents > 0) {
    if (
      result.source?.strategyFillSimulationMode !== "historical_snapshot" ||
      result.safetyLock?.strategySnapshotOnly !== true ||
      !result.blockers?.some((blocker) => blocker.id === "strategy_snapshot_only")
    ) {
      throw new Error(`Strategy snapshot evidence must stay blocked: ${JSON.stringify(result)}`);
    }
    process.stdout.write(
      "CAPITAL_PAPER_STRATEGY_EVALUATOR_CHECK=OK blocked_strategy_snapshot_only\n",
    );
    process.exit(0);
  }
  process.stdout.write("CAPITAL_PAPER_STRATEGY_EVALUATOR_CHECK=OK blocked_no_current_intents\n");
  process.exit(0);
}
if (result.safetyLock?.strategyFillPromotionGateBlocked === true) {
  if (result.recommendation !== "reject") {
    throw new Error(
      `Strategy fill promotion gate blocked but evaluator did not reject: ${JSON.stringify(result)}`,
    );
  }
  if (!result.blockers?.some((blocker) => blocker.id === "strategy_fill_promotion_gate_blocked")) {
    throw new Error(
      `Strategy fill promotion gate blocker missing: ${JSON.stringify(result.blockers)}`,
    );
  }
  if (
    !["historical_snapshot", "current_paper_blocked", "current_paper_intents"].includes(
      result.source?.strategyFillSimulationMode,
    )
  ) {
    throw new Error(`Strategy fill blocked mode unexpected: ${JSON.stringify(result.source)}`);
  }
  process.stdout.write(
    `CAPITAL_PAPER_STRATEGY_EVALUATOR_CHECK=OK blocked_strategy_fill_gate mode=${result.source.strategyFillSimulationMode}\n`,
  );
  process.exit(0);
}
if (result.source?.staleSimulationSource === true) {
  if (result.recommendation !== "reject") {
    throw new Error(`Stale fill simulation source cannot promote: ${JSON.stringify(result)}`);
  }
  if (!result.blockers?.some((blocker) => blocker.id === "stale_fill_simulation_source_empty")) {
    throw new Error(
      `Stale fill simulation source blocker missing: ${JSON.stringify(result.blockers)}`,
    );
  }
  process.stdout.write("CAPITAL_PAPER_STRATEGY_EVALUATOR_CHECK=OK blocked_stale_fill_source\n");
  process.exit(0);
}
if (
  result.source?.simulationFallbackUsed !== true &&
  result.source?.simulationSourceDigest &&
  result.source?.currentIntentSourceDigest !== result.source?.simulationSourceDigest
) {
  throw new Error(
    `Strategy evaluator source digest mismatch was not blocked: ${JSON.stringify(result.source)}`,
  );
}
if (!result.summary || result.summary.total_intents <= 0) {
  throw new Error("Strategy evaluator needs non-empty fill simulation evidence");
}
if (
  result.summary.invalid_intent_count !== 0 ||
  result.summary.unsafe_intent_count !== 0 ||
  result.summary.blocked_legacy_alias_count !== 0 ||
  result.summary.normalized_legacy_alias_count !== 0
) {
  throw new Error(
    `Strategy evaluator cannot pass dirty source evidence: ${JSON.stringify(result.summary)}`,
  );
}
if (result.summary.monte_carlo_iterations < 500) {
  throw new Error(
    `Strategy evaluator needs >=500 Monte Carlo iterations: ${result.summary.monte_carlo_iterations}`,
  );
}
if (result.recommendation === "reject" && !Array.isArray(result.failedRules)) {
  throw new Error("Rejected strategy evaluation must include failedRules");
}
if (result.summary.avg_pnl_ticks < 0 && result.recommendation !== "reject") {
  throw new Error("Negative avg_pnl_ticks cannot be promoted or reviewed automatically");
}

process.stdout.write(
  `CAPITAL_PAPER_STRATEGY_EVALUATOR_CHECK=OK recommendation=${result.recommendation} passCount=${result.passCount}/${result.ruleCount}\n`,
);
