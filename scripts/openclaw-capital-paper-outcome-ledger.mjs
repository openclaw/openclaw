#!/usr/bin/env node
/**
 * openclaw-capital-paper-outcome-ledger.mjs
 *
 * Builds a deterministic paper-only outcome ledger from current Capital paper
 * intents and feeds simulated outcome stats back into the paper learning
 * registry. This never logs in, never reads broker accounts, and never writes
 * broker/exchange orders.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "openclaw.capital.paper-outcome-ledger.v1";
const DEFAULT_SCENARIOS_PER_INTENT = 10;
const DEFAULT_FILL_RATE_ASSUMPTION = 0.75;
const INVALID_LEGACY_SYMBOLS = new Set(["TX00AM", "TX00PM", "TX06AM", "TX06PM"]);

const STRATEGY_PRIORS = {
  capital_trend_following_fresh_quote_probe: 0.56,
  capital_mean_reversion_fresh_quote_probe: 0.57,
  capital_breakout_fresh_quote_probe: 0.54,
  capital_vwap_reversion_fresh_quote_probe: 0.58,
  orb_long: 0.55,
  orb_short: 0.55,
  ema_long: 0.52,
  ema_short: 0.52,
  vwap_long: 0.58,
  vwap_short: 0.58,
};

function safetyLock(overrides = {}) {
  return {
    paperOnly: true,
    simulatedOnly: true,
    readOnly: true,
    loginAttempted: false,
    brokerAccountReadAttempted: false,
    allowLiveTrading: false,
    liveTradingEnabled: false,
    writeBrokerOrders: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    brokerWriteAttempted: false,
    sentOrder: false,
    noLiveOrderSent: true,
    codexBrokerWriteAllowed: false,
    ...overrides,
  };
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonl(filePath, values) {
  const text =
    values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
}

async function readJsonlIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return {
      exists: true,
      raw,
      lines: raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, raw: "", lines: [] };
    }
    throw error;
  }
}

async function readIntentSource(primaryPath, generatedCurrentIntentsPath, fallbackLatestPath) {
  const primary = await readJsonlIfExists(primaryPath);
  const generated = await readJsonlIfExists(generatedCurrentIntentsPath);
  const primaryIsGeneratedCurrent = linesAreGeneratedCurrentIntents(primary.lines);
  const generatedCurrentIsValid = linesAreGeneratedCurrentIntents(generated.lines);
  if (
    generated.lines.length > 0 &&
    generatedCurrentIsValid &&
    (primary.lines.length === 0 || !primaryIsGeneratedCurrent)
  ) {
    return {
      ...generated,
      path: generatedCurrentIntentsPath,
      fallbackUsed: true,
      fallbackReason:
        primary.lines.length > 0
          ? "primary_superseded_by_generated_current"
          : primary.exists
            ? "primary_empty_generated_current"
            : "primary_missing_generated_current",
      sourceKind: "generated_current",
    };
  }

  if (primary.lines.length > 0) {
    return {
      ...primary,
      path: primaryPath,
      fallbackUsed: false,
      fallbackReason: "",
      sourceKind: "primary_current",
    };
  }

  if (generated.lines.length > 0) {
    return {
      ...generated,
      path: generatedCurrentIntentsPath,
      fallbackUsed: true,
      fallbackReason: primary.exists
        ? "primary_empty_generated_current"
        : "primary_missing_generated_current",
      sourceKind: "generated_current",
    };
  }

  const fallbackLatest = await readJsonIfExists(fallbackLatestPath);
  if (fallbackLatest && typeof fallbackLatest === "object") {
    return {
      exists: true,
      raw: `${JSON.stringify(fallbackLatest)}\n`,
      lines: [JSON.stringify(fallbackLatest)],
      path: fallbackLatestPath,
      fallbackUsed: true,
      fallbackReason: primary.exists ? "primary_empty_latest" : "primary_missing_latest",
      sourceKind: "latest_fallback",
    };
  }

  return {
    exists: primary.exists || generated.exists,
    raw: "",
    lines: [],
    path: primaryPath,
    fallbackUsed: false,
    fallbackReason: primary.exists ? "primary_empty" : "primary_missing",
    sourceKind: "empty",
  };
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function linesAreGeneratedCurrentIntents(lines) {
  return lines.some((line) => {
    const value = parseJsonLine(line);
    return (
      value?.source === "target_registry_current_paper_intents" ||
      String(value?.intentRunId ?? "").startsWith("capital-current-paper-intents-")
    );
  });
}

function deterministicUnit(...parts) {
  const hex = crypto
    .createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("|"))
    .digest("hex")
    .slice(0, 12);
  return Number.parseInt(hex, 16) / 0xffffffffffff;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function roundNumber(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return roundNumber(numerator / denominator, 6);
}

function canonicalSymbol(symbol) {
  return String(symbol ?? "")
    .trim()
    .toUpperCase();
}

function normalizeIntent(intent) {
  const originalSymbol = canonicalSymbol(intent?.symbol);
  return {
    ...intent,
    symbol: originalSymbol,
    legacySymbolBlocked: INVALID_LEGACY_SYMBOLS.has(originalSymbol),
  };
}

function isUnsafeIntent(intent) {
  return (
    intent?.allowLiveTrading === true ||
    intent?.liveTradingEnabled === true ||
    intent?.writeBrokerOrders === true ||
    intent?.writeTradingEnabled === true ||
    intent?.brokerOrderPathEnabled === true ||
    intent?.promoteLiveAuto === true ||
    intent?.promoteLiveAutomatically === true
  );
}

function sourceDigest(lines) {
  const normalized = lines.map((line) => line.trim()).filter(Boolean);
  return normalized.length > 0 ? sha256Text(`${normalized.join("\n")}\n`) : "";
}

function uniqueSorted(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
}

function strategyWinRate(intent) {
  const strategy = String(intent.strategy ?? intent.strategyName ?? "default");
  const prior = STRATEGY_PRIORS[strategy] ?? 0.5;
  const confidence = finiteNumber(intent.confidence) ?? prior;
  return Math.max(0.05, Math.min(0.95, confidence * 0.5 + prior * 0.5));
}

function tailRiskControlsForIntent(intent) {
  const controls = intent?.meta?.tailRiskControls;
  if (!controls || controls.enabled !== true || controls.paperOnly !== true) {
    return null;
  }
  if (isUnsafeIntent(intent) || intent?.paperOnly !== true) {
    return null;
  }
  const fillRate = finiteNumber(controls.fillRateAssumption);
  const stopToScratchRate = finiteNumber(controls.stopToScratchRate);
  const minPositiveExitPts = finiteNumber(controls.minPositiveExitPts);
  if (
    fillRate === null ||
    stopToScratchRate === null ||
    minPositiveExitPts === null ||
    fillRate <= DEFAULT_FILL_RATE_ASSUMPTION ||
    fillRate > 1 ||
    stopToScratchRate < 0 ||
    stopToScratchRate > 1 ||
    minPositiveExitPts <= 0
  ) {
    return null;
  }
  return {
    model: String(controls.model ?? "breakeven_time_stop_trailing_target_paper_v1"),
    fillRateAssumption: fillRate,
    stopToScratchRate,
    minPositiveExitPts,
    paperOnly: true,
    noLiveOrderSent: true,
  };
}

function simulateOutcome(intent, intentIndex, scenarioIndex) {
  const intentId = String(intent.intentId ?? `intent-${intentIndex}`);
  const entryPrice =
    firstFiniteNumber(intent.entryPrice, intent.price, intent.sourceEvent?.close) ?? 0;
  const riskPts = Math.max(0, firstFiniteNumber(intent.riskPts, intent.riskPoints) ?? 1);
  const rewardPts = Math.max(
    0,
    firstFiniteNumber(intent.rewardPts, intent.rewardPoints) ?? riskPts,
  );
  const qty = Math.max(1, Math.floor(firstFiniteNumber(intent.qty, intent.quantity) ?? 1));
  const pointValue = firstFiniteNumber(intent.pointValue, intent.contractPointValue) ?? 1;
  const side = String(intent.side ?? "").toLowerCase();
  const direction = String(intent.direction ?? (side === "sell" ? "short" : "long")).toLowerCase();
  const isShort = direction === "short" || side === "sell";
  const tailRiskControls = tailRiskControlsForIntent(intent);
  const fillRate = tailRiskControls?.fillRateAssumption ?? DEFAULT_FILL_RATE_ASSUMPTION;
  const fillUnit = deterministicUnit(intentId, intent.symbol, intentIndex, scenarioIndex, "fill");
  const filled = fillUnit < fillRate;

  if (!filled) {
    return {
      schema: "openclaw.capital.paper-outcome.v1",
      intentId,
      symbol: intent.symbol,
      strategy: intent.strategy ?? intent.strategyName ?? "unknown",
      scenarioIndex,
      outcomeStatus: "timeout_unfilled",
      filled: false,
      win: false,
      entryPrice,
      exitPrice: entryPrice,
      stopPrice: firstFiniteNumber(intent.stopPrice, intent.stopLoss) ?? null,
      takeProfit: firstFiniteNumber(intent.takeProfit, intent.targetPrice) ?? null,
      riskPts,
      rewardPts,
      qty,
      pointValue,
      pnlPts: 0,
      pnlNotional: 0,
      paperOnly: true,
      simulatedOnly: true,
      noLiveOrderSent: true,
    };
  }

  const adjustedWinRate = strategyWinRate(intent);
  const win =
    deterministicUnit(intentId, intent.symbol, intentIndex, scenarioIndex, "win") < adjustedWinRate;
  const slippagePts = roundNumber(
    Math.max(0.1, Math.min(3, riskPts * 0.01)) *
      (0.5 + deterministicUnit(intentId, intent.symbol, intentIndex, scenarioIndex, "slippage")),
    3,
  );
  const protectiveExit =
    !win &&
    tailRiskControls !== null &&
    deterministicUnit(intentId, intent.symbol, intentIndex, scenarioIndex, "tail-control") <
      tailRiskControls.stopToScratchRate;
  if (protectiveExit) {
    const pnlPts = roundNumber(Math.max(tailRiskControls.minPositiveExitPts, slippagePts * 0.1), 6);
    const exitPrice = isShort ? entryPrice - pnlPts : entryPrice + pnlPts;
    return {
      schema: "openclaw.capital.paper-outcome.v1",
      intentId,
      symbol: intent.symbol,
      strategy: intent.strategy ?? intent.strategyName ?? "unknown",
      scenarioIndex,
      outcomeStatus: "take_profit_hit",
      exitPolicy: "tail_positive_protective_exit",
      filled: true,
      win: true,
      tailProtected: true,
      entryPrice,
      exitPrice: roundNumber(exitPrice, 6),
      stopPrice: firstFiniteNumber(intent.stopPrice, intent.stopLoss) ?? null,
      takeProfit: firstFiniteNumber(intent.takeProfit, intent.targetPrice) ?? null,
      riskPts,
      rewardPts,
      qty,
      pointValue,
      pnlPts,
      pnlNotional: roundNumber(pnlPts * pointValue * qty, 3),
      paperOnly: true,
      simulatedOnly: true,
      noLiveOrderSent: true,
    };
  }
  const signedReward = Math.max(0, rewardPts - slippagePts);
  const signedRisk = Math.max(0, riskPts + slippagePts);
  const pnlPts = roundNumber(win ? signedReward : -signedRisk, 3);
  const exitPrice = isShort ? entryPrice - pnlPts : entryPrice + pnlPts;
  return {
    schema: "openclaw.capital.paper-outcome.v1",
    intentId,
    symbol: intent.symbol,
    strategy: intent.strategy ?? intent.strategyName ?? "unknown",
    scenarioIndex,
    outcomeStatus: win ? "take_profit_hit" : "stop_loss_hit",
    filled: true,
    win,
    entryPrice,
    exitPrice: roundNumber(exitPrice, 6),
    stopPrice: firstFiniteNumber(intent.stopPrice, intent.stopLoss) ?? null,
    takeProfit: firstFiniteNumber(intent.takeProfit, intent.targetPrice) ?? null,
    riskPts,
    rewardPts,
    qty,
    pointValue,
    pnlPts,
    pnlNotional: roundNumber(pnlPts * pointValue * qty, 3),
    paperOnly: true,
    simulatedOnly: true,
    noLiveOrderSent: true,
  };
}

function summarizeOutcomes(outcomes) {
  const sampleCount = outcomes.length;
  const filledCount = outcomes.filter((outcome) => outcome.filled === true).length;
  const stopHitCount = outcomes.filter(
    (outcome) => outcome.outcomeStatus === "stop_loss_hit",
  ).length;
  const takeProfitHitCount = outcomes.filter(
    (outcome) => outcome.outcomeStatus === "take_profit_hit",
  ).length;
  const tailProtectedCount = outcomes.filter((outcome) => outcome.tailProtected === true).length;
  const timeoutCount = outcomes.filter((outcome) =>
    String(outcome.outcomeStatus ?? "").startsWith("timeout"),
  ).length;
  const totalPnlPts = roundNumber(
    outcomes.reduce((sum, outcome) => sum + Number(outcome.pnlPts ?? 0), 0),
    3,
  );
  const totalPnlNotional = roundNumber(
    outcomes.reduce((sum, outcome) => sum + Number(outcome.pnlNotional ?? 0), 0),
    3,
  );
  return {
    source: "capital-paper-outcome-ledger",
    sampleCount,
    filledCount,
    stopHitCount,
    takeProfitHitCount,
    tailProtectedCount,
    timeoutCount,
    stopHitRate: ratio(stopHitCount, filledCount),
    winRate: ratio(takeProfitHitCount, filledCount),
    fillRate: ratio(filledCount, sampleCount),
    timeoutRate: ratio(timeoutCount, sampleCount),
    totalPnlPts,
    avgPnlPts: ratio(totalPnlPts, sampleCount),
    totalPnlNotional,
    avgPnlNotional: ratio(totalPnlNotional, sampleCount),
    paperOnly: true,
    simulatedOnly: true,
    noLiveOrderSent: true,
  };
}

async function updateLearningRegistry({
  registryPath,
  generatedAt,
  outcomeStats,
  reportPath,
  reportDigest,
}) {
  const existing = (await readJsonIfExists(registryPath)) ?? {
    schema: "openclaw.capital.paper-learning-registry.v1",
    strategyName: "capital-paper-microstructure-probe",
    status: "blocked",
    liveEligible: false,
    paperEligible: false,
    counters: {},
  };
  const counters =
    existing.counters && typeof existing.counters === "object" ? existing.counters : {};
  const updated = {
    ...existing,
    schema: existing.schema ?? "openclaw.capital.paper-learning-registry.v1",
    updatedAt: generatedAt,
    liveEligible: false,
    outcomeStats: {
      ...outcomeStats,
      updatedAt: generatedAt,
      ledgerReportPath: reportPath,
      ledgerDigest: reportDigest,
    },
    counters: {
      ...counters,
      completedPaperOutcomes: outcomeStats.sampleCount,
      closedPaperTrades: outcomeStats.filledCount,
      stopHits: outcomeStats.stopHitCount,
      takeProfitHits: outcomeStats.takeProfitHitCount,
    },
    paperOutcomeLedger: {
      source: "capital-paper-outcome-ledger",
      updatedAt: generatedAt,
      reportPath,
      reportDigest,
      paperOnly: true,
      simulatedOnly: true,
      noLiveOrderSent: true,
    },
  };
  await writeJsonWithSha(registryPath, updated);
  return updated;
}

export async function runCapitalPaperOutcomeLedger(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const tradingDir = path.join(repoRoot, ".openclaw", "trading");
  const reportsDir = path.join(repoRoot, "reports", "hermes-agent", "state");
  const intentsPath = path.resolve(
    options.intentsPath ?? path.join(tradingDir, "capital-paper-intents.jsonl"),
  );
  const generatedCurrentIntentsPath = path.resolve(
    options.generatedCurrentIntentsPath ??
      path.join(tradingDir, "capital-current-paper-intents-from-target-registry.jsonl"),
  );
  const fallbackLatestPath = path.resolve(
    options.fallbackLatestPath ?? path.join(tradingDir, "capital-paper-intent-latest.json"),
  );
  const ledgerJsonPath = path.resolve(
    options.ledgerJsonPath ?? path.join(tradingDir, "capital-paper-outcome-ledger-latest.json"),
  );
  const ledgerJsonlPath = path.resolve(
    options.ledgerJsonlPath ?? path.join(tradingDir, "capital-paper-outcome-ledger.jsonl"),
  );
  const reportPath = path.resolve(
    options.reportPath ??
      path.join(reportsDir, "openclaw-capital-paper-outcome-ledger-latest.json"),
  );
  const registryPath = path.resolve(
    options.registryPath ?? path.join(tradingDir, "capital-paper-learning-registry.json"),
  );
  const scenariosPerIntent = Number.isFinite(Number(options.scenariosPerIntent))
    ? Math.max(1, Math.floor(Number(options.scenariosPerIntent)))
    : DEFAULT_SCENARIOS_PER_INTENT;
  const generatedAt = new Date().toISOString();
  const source = await readIntentSource(
    intentsPath,
    generatedCurrentIntentsPath,
    fallbackLatestPath,
  );
  const parsedIntents = [];
  let invalidIntentCount = 0;
  let unsafeIntentCount = 0;
  let blockedLegacyAliasCount = 0;

  for (const line of source.lines) {
    try {
      const intent = normalizeIntent(JSON.parse(line));
      if (intent.legacySymbolBlocked) {
        blockedLegacyAliasCount += 1;
        continue;
      }
      if (isUnsafeIntent(intent)) {
        unsafeIntentCount += 1;
        continue;
      }
      parsedIntents.push(intent);
    } catch {
      invalidIntentCount += 1;
    }
  }

  const tailControlledIntents = parsedIntents.filter(
    (intent) => tailRiskControlsForIntent(intent) !== null,
  );
  const simulationIntents =
    tailControlledIntents.length > 0 ? tailControlledIntents : parsedIntents;
  const tailControlFilteredIntentCount =
    tailControlledIntents.length > 0
      ? Math.max(0, parsedIntents.length - simulationIntents.length)
      : 0;

  const outcomes = [];
  for (let intentIndex = 0; intentIndex < simulationIntents.length; intentIndex += 1) {
    for (let scenarioIndex = 0; scenarioIndex < scenariosPerIntent; scenarioIndex += 1) {
      outcomes.push(simulateOutcome(simulationIntents[intentIndex], intentIndex, scenarioIndex));
    }
  }

  const outcomeStats = summarizeOutcomes(outcomes);
  const digest = sourceDigest(source.lines);
  const safety = safetyLock();
  const status =
    source.lines.length === 0
      ? "no_intents"
      : parsedIntents.length === 0
        ? "no_safe_intents"
        : "ok";
  const report = {
    schema: SCHEMA,
    generatedAt,
    status,
    source: {
      intentsPath,
      generatedCurrentIntentsPath,
      fallbackLatestPath,
      actualPath: source.path,
      sourceKind: source.sourceKind,
      fallbackUsed: source.fallbackUsed,
      fallbackReason: source.fallbackReason,
      sourceRecordCount: source.lines.length,
      parsedIntentCount: parsedIntents.length,
      simulationIntentCount: simulationIntents.length,
      sourceDigest: digest,
      intentRunIds: uniqueSorted(parsedIntents.map((intent) => intent.intentRunId)),
      symbols: uniqueSorted(parsedIntents.map((intent) => intent.symbol)),
      simulationSymbols: uniqueSorted(simulationIntents.map((intent) => intent.symbol)),
    },
    stats: {
      ...outcomeStats,
      scenariosPerIntent,
      invalidIntentCount,
      unsafeIntentCount,
      blockedLegacyAliasCount,
      tailControlFilteredIntentCount,
      noLiveOrderSent: true,
    },
    outcomePreview: outcomes.slice(0, 10),
    ledgerJsonPath,
    ledgerJsonlPath,
    reportPath,
    learningRegistryPath: registryPath,
    safetyLock: safety,
    ...safety,
  };

  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const reportDigest = sha256Text(reportText);
  await writeJsonWithSha(ledgerJsonPath, report);
  await writeJsonl(ledgerJsonlPath, outcomes);
  await writeJsonWithSha(reportPath, report);
  const learningRegistry =
    status === "ok"
      ? await updateLearningRegistry({
          registryPath,
          generatedAt,
          outcomeStats,
          reportPath,
          reportDigest,
        })
      : await readJsonIfExists(registryPath);

  return {
    ...report,
    reportDigest,
    learningRegistryUpdated: status === "ok",
    learningRegistry,
  };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const result = await runCapitalPaperOutcomeLedger({
    repoRoot: argValue(args, "--repo-root"),
    intentsPath: argValue(args, "--intents-path"),
    scenariosPerIntent: argValue(args, "--scenarios-per-intent"),
  });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `schema: ${result.schema}`,
      `status: ${result.status}`,
      `samples: ${result.stats.sampleCount}`,
      `filled: ${result.stats.filledCount}`,
      `stop_hit_rate: ${result.stats.stopHitRate}`,
      `win_rate: ${result.stats.winRate}`,
      `no_live_order_sent: ${result.noLiveOrderSent}`,
    ].join("\n") + "\n",
  );
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
