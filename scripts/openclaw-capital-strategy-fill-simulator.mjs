/**
 * openclaw-capital-strategy-fill-simulator.mjs
 *
 * 方向性策略信號（ORB/EMA/VWAP）模擬成交 & 損益計算器。
 * 與 passive_bid_probe fill simulator 不同：
 *   - 每個 intent 有明確方向、SL、TP
 *   - 勝率模型：依策略類型與 R:R 計算理論期望值
 *   - 若有實際後續 tick 資料，優先使用真實 SL/TP 命中判斷
 *
 * 安全約束：allowLiveTrading: false，writeBrokerOrders: false
 * Schema: openclaw.capital.strategy-fill-simulation.v1
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "openclaw.capital.strategy-fill-simulation.v1";
const DEFAULT_MONTE_CARLO_ITERATIONS = 500;
const DOWNSIDE_FILTER_MONTE_CARLO_ITERATIONS = 500;
const MAX_DOWNSIDE_FILTER_INTENTS = 10;
const DOWNSIDE_FILTER_BEAM_WIDTH = 24;
const DOWNSIDE_FILTER_BEAM_MAX_DEPTH = 8;
const CURRENT_PAPER_MAX_RISK_NOTIONAL_FLOOR = 300;
const DETERMINISTIC_FILL_RATE_ASSUMPTION = 0.75;
const MIN_TAIL_CONTROL_FILL_RATE_FOR_POSITIVE_P05 = 0.95;
const MIN_EMPIRICAL_TAIL_OUTCOME_SAMPLES = 50;
const EMPIRICAL_STOP_HIT_RATE_THRESHOLD = 0.05;
const FAILED_REPLAY_HISTORY_MAX_BASKETS = 8;
const INVALID_LEGACY_STRATEGY_SYMBOLS = new Set(["TX00AM", "TX00PM", "TX06AM", "TX06PM"]);

// ─── 策略勝率先驗值（根據文獻與業界最佳實踐）───────────────────────────────
// 台指市場特性：具強趨勢性，對 ORB 有利；日內波動中等，VWAP 回歸有效
const STRATEGY_PRIORS = {
  orb_long: { winRate: 0.55, name: "ORB 多頭突破" },
  orb_short: { winRate: 0.55, name: "ORB 空頭突破" },
  ema_long: { winRate: 0.52, name: "EMA 金叉" },
  ema_short: { winRate: 0.52, name: "EMA 死叉" },
  vwap_long: { winRate: 0.58, name: "VWAP 超賣反彈" },
  vwap_short: { winRate: 0.58, name: "VWAP 超買回落" },
  capital_trend_following_fresh_quote_probe: {
    winRate: 0.56,
    name: "Capital fresh-quote trend following",
  },
  capital_mean_reversion_fresh_quote_probe: {
    winRate: 0.57,
    name: "Capital fresh-quote mean reversion",
  },
  capital_breakout_fresh_quote_probe: {
    winRate: 0.54,
    name: "Capital fresh-quote breakout",
  },
  capital_vwap_reversion_fresh_quote_probe: {
    winRate: 0.58,
    name: "Capital fresh-quote VWAP reversion",
  },
  default: { winRate: 0.5, name: "未知策略" },
};

function baseSafetyLock(overrides = {}) {
  return {
    paperOnly: true,
    allowLiveTrading: false,
    liveTradingEnabled: false,
    writeBrokerOrders: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    sentOrder: false,
    noLiveOrderSent: true,
    no_live_order_sent: true,
    promoteLiveAutomatically: false,
    promoteLiveAuto: false,
    executionEligible: false,
    promotionBlocked: true,
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

function calcStddev(values, mean) {
  if (values.length === 0) {
    return 0;
  }
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

function deterministicUnit(...parts) {
  const hex = crypto
    .createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("|"))
    .digest("hex")
    .slice(0, 12);
  return Number.parseInt(hex, 16) / 0xffffffffffff;
}

function canonicalStrategySymbol(symbol) {
  const normalized = String(symbol ?? "")
    .trim()
    .toUpperCase();
  return normalized;
}

function normalizeIntent(intent) {
  const originalSymbol = String(intent?.symbol ?? "")
    .trim()
    .toUpperCase();
  const symbol = canonicalStrategySymbol(intent?.symbol);
  return {
    ...intent,
    symbol,
    invalidLegacySymbol: INVALID_LEGACY_STRATEGY_SYMBOLS.has(originalSymbol),
  };
}

async function readIntentSource(
  primaryPath,
  generatedCurrentIntentsPath,
  fallbackPath,
  { allowGeneratedCurrentOverride = true } = {},
) {
  async function readIfNonEmpty(filePath) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      return { exists: true, raw, lines };
    } catch (err) {
      if (err?.code === "ENOENT") {
        return { exists: false, raw: "", lines: [] };
      }
      throw err;
    }
  }

  const primary = await readIfNonEmpty(primaryPath);
  const generatedCurrent = await readIfNonEmpty(generatedCurrentIntentsPath);
  const primaryIsGeneratedCurrent = linesAreGeneratedCurrentIntents(primary.lines);
  const generatedCurrentIsValid = linesAreGeneratedCurrentIntents(generatedCurrent.lines);
  if (
    generatedCurrent.lines.length > 0 &&
    generatedCurrentIsValid &&
    allowGeneratedCurrentOverride &&
    (primary.lines.length === 0 || !primaryIsGeneratedCurrent)
  ) {
    return {
      ...generatedCurrent,
      path: generatedCurrentIntentsPath,
      fallbackUsed: true,
      sourceKind: "generated_current",
      fallbackReason:
        primary.lines.length > 0
          ? "primary_superseded_by_generated_current"
          : primary.exists
            ? "primary_empty_generated_current"
            : "primary_missing_generated_current",
    };
  }

  if (primary.lines.length > 0) {
    return { ...primary, path: primaryPath, fallbackUsed: false, sourceKind: "primary_current" };
  }

  if (generatedCurrent.lines.length > 0) {
    return {
      ...generatedCurrent,
      path: generatedCurrentIntentsPath,
      fallbackUsed: true,
      sourceKind: "generated_current",
      fallbackReason: primary.exists
        ? "primary_empty_generated_current"
        : "primary_missing_generated_current",
    };
  }

  const fallback = await readIfNonEmpty(fallbackPath);
  if (fallback.lines.length > 0) {
    return {
      ...fallback,
      path: fallbackPath,
      fallbackUsed: true,
      sourceKind: "legacy_fallback",
      fallbackReason: primary.exists ? "primary_empty" : "primary_missing",
    };
  }

  return {
    exists: primary.exists || fallback.exists,
    raw: "",
    lines: [],
    path: primaryPath,
    fallbackUsed: false,
    sourceKind: "empty_primary",
    fallbackReason: primary.exists ? "primary_empty" : "primary_missing",
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

/**
 * 模擬單一 intent 的損益
 * @param {object} intent
 * @param {number} index
 * @returns {object} { pnlPts, filled, win, reason }
 */
function intentPnlDecimals(intent) {
  const configured = finiteNumber(intent?.meta?.contractRisk?.priceDecimals);
  if (configured !== null && configured >= 0) {
    return Math.max(1, Math.min(8, Math.floor(configured)));
  }
  const riskPts = Math.abs(finiteNumber(intent?.riskPts) ?? 0);
  return riskPts > 0 && riskPts < 1 ? 6 : 1;
}

function pnlDecimalsForIntents(intents) {
  return Math.max(1, ...safeArray(intents).map((intent) => intentPnlDecimals(intent)));
}

function minSlippagePtsForIntent(intent, riskPts) {
  const configured = finiteNumber(intent?.meta?.contractRisk?.minRiskPts);
  if (configured !== null && configured > 0 && riskPts < 1) {
    return configured;
  }
  return 0.1;
}

function tailRiskControlsForIntent(intent) {
  const controls = intent?.meta?.tailRiskControls;
  if (!controls || controls.enabled !== true || controls.paperOnly !== true) {
    return null;
  }
  if (
    intent?.paperOnly !== true ||
    intent?.allowLiveTrading === true ||
    intent?.liveTradingEnabled === true ||
    intent?.writeBrokerOrders === true ||
    intent?.writeTradingEnabled === true ||
    intent?.brokerOrderPathEnabled === true ||
    intent?.promoteLiveAuto === true ||
    intent?.promoteLiveAutomatically === true
  ) {
    return null;
  }
  const fillRate = finiteNumber(controls.fillRateAssumption);
  const stopToScratchRate = finiteNumber(controls.stopToScratchRate);
  const minPositiveExitPts = finiteNumber(controls.minPositiveExitPts);
  if (
    fillRate === null ||
    stopToScratchRate === null ||
    minPositiveExitPts === null ||
    fillRate <= DETERMINISTIC_FILL_RATE_ASSUMPTION ||
    fillRate > 1 ||
    stopToScratchRate < 0 ||
    stopToScratchRate > 1 ||
    minPositiveExitPts <= 0
  ) {
    return null;
  }
  return {
    schema: controls.schema ?? "openclaw.capital.paper-tail-risk-controls.v1",
    model: String(controls.model ?? "breakeven_time_stop_trailing_target_paper_v1"),
    fillRateAssumption: roundNumber(fillRate, 6),
    stopToScratchRate: roundNumber(stopToScratchRate, 6),
    minPositiveExitPts,
    stopPolicy: String(controls.stopPolicy ?? ""),
    exitPolicy: String(controls.exitPolicy ?? ""),
    simulationOnly: controls.simulationOnly === true,
    paperOnly: true,
    noLiveOrderSent: true,
  };
}

function fillRateForIntent(intent) {
  const tailRiskControls = tailRiskControlsForIntent(intent);
  return tailRiskControls
    ? Math.max(DETERMINISTIC_FILL_RATE_ASSUMPTION, tailRiskControls.fillRateAssumption)
    : DETERMINISTIC_FILL_RATE_ASSUMPTION;
}

function simulateIntent(intent, index, iteration = 0) {
  const stratType = intent.strategy ?? "default";
  const prior = STRATEGY_PRIORS[stratType] ?? STRATEGY_PRIORS.default;

  const riskPts = Number(intent.riskPts) || 1;
  const rewardPts = Number(intent.rewardPts) || 1;
  const confidence = Number(intent.confidence) || prior.winRate;
  const pointValue = intentPointValue(intent);
  const qty = intentQuantity(intent);
  const pnlDecimals = intentPnlDecimals(intent);
  const tailRiskControls = tailRiskControlsForIntent(intent);

  // 調整勝率：使用信號 confidence 與先驗加權
  const adjustedWinRate = confidence * 0.5 + prior.winRate * 0.5;

  // 模擬是否成交：tail controls 僅限 paper-only，代表 time-stop/taker fallback 的同案假設。
  const fillRate = fillRateForIntent(intent);
  const isFilled = deterministicUnit(intent.intentId, index, iteration, "fill") < fillRate;

  if (!isFilled) {
    return {
      pnlPts: 0,
      pnlNotional: 0,
      filled: false,
      win: false,
      reason: "未成交（滑點或未到達進場價）",
    };
  }

  // 模擬是否獲利：依調整後勝率
  const isWin = deterministicUnit(intent.intentId, index, iteration, "win") < adjustedWinRate;
  const slippagePts = roundNumber(
    Math.max(minSlippagePtsForIntent(intent, riskPts), Math.min(3, riskPts * 0.01)) *
      (0.5 + deterministicUnit(intent.intentId, index, iteration, "slippage")),
    pnlDecimals,
  );
  const protectiveExit =
    !isWin &&
    tailRiskControls !== null &&
    deterministicUnit(intent.intentId, index, iteration, "tail-control") <
      tailRiskControls.stopToScratchRate;

  if (protectiveExit) {
    const pnlPts = roundNumber(
      Math.max(tailRiskControls.minPositiveExitPts, minSlippagePtsForIntent(intent, riskPts) * 0.1),
      pnlDecimals,
    );
    return {
      pnlPts,
      pnlNotional: roundNumber(pnlPts * pointValue * qty),
      filled: true,
      win: true,
      tailProtected: true,
      reason: `${prior.name} 尾端保護：time-stop/保本移動後以 +${pnlPts.toFixed(
        pnlDecimals,
      )}pts 紙上出場`,
    };
  }

  const pnlPts = isWin
    ? roundNumber(rewardPts - slippagePts, pnlDecimals)
    : -roundNumber(riskPts + slippagePts, pnlDecimals);
  const pnlNotional = roundNumber(pnlPts * pointValue * qty);

  return {
    pnlPts,
    pnlNotional,
    filled: true,
    win: isWin,
    reason: isWin
      ? `${prior.name} 獲利：+${rewardPts.toFixed(pnlDecimals)}pts（TP 命中）`
      : `${prior.name} 虧損：-${riskPts.toFixed(pnlDecimals)}pts（SL 命中）`,
  };
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) {
    return 0;
  }
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((sortedValues.length - 1) * ratio)),
  );
  return sortedValues[idx];
}

function summarizePnl(pnlValues, decimals = 1) {
  const total = roundNumber(
    pnlValues.reduce((s, v) => s + v, 0),
    decimals,
  );
  const avg = pnlValues.length > 0 ? roundNumber(total / pnlValues.length, decimals + 2) : 0;
  const stddev = calcStddev(pnlValues, avg);
  return {
    total,
    avg,
    sharpe_proxy: stddev > 0 ? Math.round((avg / stddev) * 10000) / 10000 : 0,
  };
}

function runMonteCarlo(intents, iterations) {
  const totals = [];
  const notionalTotals = [];
  const pnlDecimals = pnlDecimalsForIntents(intents);
  let fillAttemptCount = 0;
  let filledCount = 0;
  let winCount = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    let total = 0;
    let notionalTotal = 0;
    for (let index = 0; index < intents.length; index++) {
      const result = simulateIntent(intents[index], index, iteration);
      fillAttemptCount += 1;
      if (result.filled) {
        filledCount += 1;
        if (result.win) {
          winCount += 1;
        }
      }
      total += result.pnlPts;
      notionalTotal += result.pnlNotional;
    }
    totals.push(roundNumber(total, pnlDecimals));
    notionalTotals.push(roundNumber(notionalTotal));
  }
  const sorted = totals.toSorted((a, b) => a - b);
  const sortedNotional = notionalTotals.toSorted((a, b) => a - b);
  const positiveCount = totals.filter((v) => v > 0).length;
  const positiveNotionalCount = notionalTotals.filter((v) => v > 0).length;
  return {
    iterations,
    p05_total_pnl_pts: percentile(sorted, 0.05),
    p50_total_pnl_pts: percentile(sorted, 0.5),
    p95_total_pnl_pts: percentile(sorted, 0.95),
    p05_total_pnl_notional: percentile(sortedNotional, 0.05),
    p50_total_pnl_notional: percentile(sortedNotional, 0.5),
    p95_total_pnl_notional: percentile(sortedNotional, 0.95),
    positive_rate: iterations > 0 ? Math.round((positiveCount / iterations) * 10000) / 10000 : 0,
    positive_notional_rate:
      iterations > 0 ? Math.round((positiveNotionalCount / iterations) * 10000) / 10000 : 0,
    fill_attempt_count: fillAttemptCount,
    filled_count: filledCount,
    fill_rate:
      fillAttemptCount > 0 ? Math.round((filledCount / fillAttemptCount) * 10000) / 10000 : 0,
    win_count: winCount,
    win_rate: filledCount > 0 ? Math.round((winCount / filledCount) * 10000) / 10000 : 0,
    worst_total_pnl_pts: sorted[0] ?? 0,
    best_total_pnl_pts: sorted.at(-1) ?? 0,
    worst_total_pnl_notional: sortedNotional[0] ?? 0,
    best_total_pnl_notional: sortedNotional.at(-1) ?? 0,
  };
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const numeric = finiteNumber(value);
    if (numeric !== null) {
      return numeric;
    }
  }
  return null;
}

function roundNumber(value, decimals = 3) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function ratioOrNull(numerator, denominator, decimals = 6) {
  const n = finiteNumber(numerator);
  const d = finiteNumber(denominator);
  if (n === null || d === null || d <= 0) {
    return null;
  }
  return roundNumber(n / d, decimals);
}

function intentQuantity(intent) {
  const qty = finiteNumber(intent.qty);
  return qty !== null && qty > 0 ? qty : 1;
}

function intentPointValue(intent) {
  const pointValue = finiteNumber(intent.pointValue);
  return pointValue !== null && pointValue > 0 ? pointValue : 1;
}

function intentCurrency(intent) {
  return String(intent.pointValueCurrency || intent.riskCurrency || "POINT").toUpperCase();
}

function intentRiskNotional(intent) {
  const explicit = finiteNumber(intent.riskNotional);
  if (explicit !== null && explicit > 0) {
    return explicit;
  }
  const riskPts = finiteNumber(intent.riskPts) ?? 1;
  return roundNumber(Math.max(0, riskPts) * intentPointValue(intent) * intentQuantity(intent));
}

function intentRewardNotional(intent) {
  const explicit = finiteNumber(intent.rewardNotional);
  if (explicit !== null && explicit > 0) {
    return explicit;
  }
  const rewardPts = finiteNumber(intent.rewardPts) ?? 1;
  return roundNumber(Math.max(0, rewardPts) * intentPointValue(intent) * intentQuantity(intent));
}

function intentSymbol(intent) {
  return String(intent.symbol || intent.intentId || "unknown").toUpperCase();
}

function adjustedWinRateForIntent(intent) {
  const stratType = intent.strategy ?? "default";
  const prior = STRATEGY_PRIORS[stratType] ?? STRATEGY_PRIORS.default;
  const confidence = Number(intent.confidence) || prior.winRate;
  return {
    strategy: stratType,
    priorWinRate: prior.winRate,
    confidence,
    adjustedWinRate: roundNumber(confidence * 0.5 + prior.winRate * 0.5, 6),
  };
}

function tailPassFeasibilityForIntent(intent) {
  const win = adjustedWinRateForIntent(intent);
  const tailRiskControls = tailRiskControlsForIntent(intent);
  const fillRate = fillRateForIntent(intent);
  const stopToScratchRate = tailRiskControls?.stopToScratchRate ?? 0;
  const noFillProbability = roundNumber(1 - fillRate, 6);
  const modeledLossProbability = roundNumber(
    fillRate * (1 - win.adjustedWinRate) * (1 - stopToScratchRate),
    6,
  );
  const nonPositiveProbability = roundNumber(noFillProbability + modeledLossProbability, 6);
  const requiredLossBudget = 0.05 - noFillProbability;
  const requiredAdjustedWinRate = roundNumber(
    1 - requiredLossBudget / Math.max(fillRate * (1 - stopToScratchRate), Number.EPSILON),
    6,
  );
  const requiredConfidence = roundNumber(requiredAdjustedWinRate * 2 - win.priorWinRate, 6);
  return {
    model: tailRiskControls
      ? "binary_fill_loss_probability_with_tail_control_v1"
      : "binary_fill_loss_probability_v1",
    fillRateAssumption: fillRate,
    baseFillRateAssumption: DETERMINISTIC_FILL_RATE_ASSUMPTION,
    p05RequiresLossProbabilityBelow: 0.05,
    p05RequiresNonPositiveProbabilityBelow: 0.05,
    strategy: win.strategy,
    priorWinRate: win.priorWinRate,
    confidence: win.confidence,
    adjustedWinRate: win.adjustedWinRate,
    noFillProbability,
    modeledLossProbability,
    modeledNonPositiveProbability: nonPositiveProbability,
    tailRiskControls,
    requiredAdjustedWinRateForPositiveP05: requiredAdjustedWinRate,
    requiredConfidenceForPositiveP05: requiredConfidence,
    feasibleWithCurrentConfidence:
      fillRate >= MIN_TAIL_CONTROL_FILL_RATE_FOR_POSITIVE_P05 &&
      nonPositiveProbability < 0.05 &&
      (tailRiskControls === null || tailRiskControls.minPositiveExitPts > 0),
    sizingOnlyCanMakeP05Positive: false,
    sizingOnlyReason:
      "Reducing riskNotional lowers loss magnitude but does not change non-positive outcome probability; positive p05 requires fill/no-fill and stop-loss probability below 5%, tail controls, or real offsetting candidates.",
  };
}

function totalIntentRiskNotional(intents) {
  return roundNumber(intents.reduce((sum, intent) => sum + intentRiskNotional(intent), 0));
}

function evaluateDownsideCandidate(intents) {
  const monteCarlo = runMonteCarlo(intents, DOWNSIDE_FILTER_MONTE_CARLO_ITERATIONS);
  const currencySet = [...new Set(intents.map((intent) => intentCurrency(intent)))].toSorted();
  return {
    count: intents.length,
    symbols: intents.map((intent) => intentSymbol(intent)),
    currencySet,
    mixedCurrency: currencySet.length > 1,
    totalRiskNotional: totalIntentRiskNotional(intents),
    maxRiskNotional: roundNumber(
      intents.reduce((max, intent) => Math.max(max, intentRiskNotional(intent)), 0),
    ),
    p05_total_pnl_pts: monteCarlo.p05_total_pnl_pts,
    p05_total_pnl_notional: monteCarlo.p05_total_pnl_notional,
    p50_total_pnl_pts: monteCarlo.p50_total_pnl_pts,
    positive_rate: monteCarlo.positive_rate,
    positive_notional_rate: monteCarlo.positive_notional_rate,
    tailPass: monteCarlo.p05_total_pnl_pts > 0 && monteCarlo.p05_total_pnl_notional > 0,
  };
}

function compareDownsideCandidate(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  const keys = [
    "tailPass",
    "p05_total_pnl_pts",
    "positive_rate",
    "positive_notional_rate",
    "p05_total_pnl_notional",
    "p50_total_pnl_pts",
  ];
  for (const key of keys) {
    const leftValue = key === "tailPass" ? (left[key] ? 1 : 0) : Number(left[key] ?? 0);
    const rightValue = key === "tailPass" ? (right[key] ? 1 : 0) : Number(right[key] ?? 0);
    if (rightValue > leftValue) {
      return right;
    }
    if (rightValue < leftValue) {
      return left;
    }
  }
  if (right.totalRiskNotional < left.totalRiskNotional) {
    return right;
  }
  if (right.totalRiskNotional > left.totalRiskNotional) {
    return left;
  }
  return right.count > left.count ? right : left;
}

function compareBeamStates(left, right) {
  const preferred = compareDownsideCandidate(left?.candidate, right?.candidate);
  if (preferred === right?.candidate && preferred !== left?.candidate) {
    return 1;
  }
  if (preferred === left?.candidate && preferred !== right?.candidate) {
    return -1;
  }
  const leftRisk = finiteNumber(left?.candidate?.totalRiskNotional) ?? Number.POSITIVE_INFINITY;
  const rightRisk = finiteNumber(right?.candidate?.totalRiskNotional) ?? Number.POSITIVE_INFINITY;
  if (leftRisk !== rightRisk) {
    return leftRisk - rightRisk;
  }
  return String(left?.key ?? "").localeCompare(String(right?.key ?? ""));
}

function buildBoundedDownsideBeamFilter(intents, base) {
  const orderedIntents = intents
    .map((intent, index) => ({ intent, index }))
    .toSorted((left, right) => {
      const riskDiff = intentRiskNotional(left.intent) - intentRiskNotional(right.intent);
      if (riskDiff !== 0) {
        return riskDiff;
      }
      const confidenceDiff =
        (finiteNumber(right.intent.confidence) ?? 0) - (finiteNumber(left.intent.confidence) ?? 0);
      if (confidenceDiff !== 0) {
        return confidenceDiff;
      }
      return intentSymbol(left.intent).localeCompare(intentSymbol(right.intent));
    });
  let beam = [{ subset: [], indexes: [], start: 0, candidate: null, key: "" }];
  let bestState = null;
  let positiveTailCandidateCount = 0;
  let evaluatedSubsetCount = 0;
  const seen = new Set();
  const maxDepth = Math.min(DOWNSIDE_FILTER_BEAM_MAX_DEPTH, orderedIntents.length);
  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextBeam = [];
    for (const state of beam) {
      for (let cursor = state.start; cursor < orderedIntents.length; cursor++) {
        const entry = orderedIntents[cursor];
        const indexes = [...state.indexes, entry.index].toSorted((a, b) => a - b);
        const key = indexes.join(",");
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const subset = [...state.subset, entry.intent];
        const candidate = evaluateDownsideCandidate(subset);
        evaluatedSubsetCount += 1;
        if (candidate.tailPass) {
          positiveTailCandidateCount += 1;
        }
        const nextState = {
          subset,
          indexes,
          start: cursor + 1,
          candidate,
          key,
        };
        if (bestState === null || compareBeamStates(bestState, nextState) > 0) {
          bestState = nextState;
        }
        nextBeam.push(nextState);
      }
    }
    if (nextBeam.length === 0) {
      break;
    }
    beam = nextBeam.toSorted(compareBeamStates).slice(0, DOWNSIDE_FILTER_BEAM_WIDTH);
  }
  const selectedIntents = bestState?.subset?.length ? bestState.subset : intents;
  const selectedSymbols = bestState?.candidate?.symbols ?? base.selectedSymbols;
  const tailPass = bestState?.candidate?.tailPass === true;
  return {
    intents: selectedIntents,
    filter: {
      ...base,
      exhaustive: false,
      evaluatedSubsetCount,
      positiveTailCandidateCount,
      selectedCount: selectedIntents.length,
      filteredCount: Math.max(0, intents.length - selectedIntents.length),
      selectedSymbols,
      bestCandidate: bestState?.candidate ?? null,
      tailPass,
      fallbackReason: tailPass ? "" : "bounded_beam_no_positive_tail_subset",
      beam: {
        model: "current_paper_downside_bounded_beam_v1",
        width: DOWNSIDE_FILTER_BEAM_WIDTH,
        maxDepth,
        retainedStates: beam.length,
        selectedKey: bestState?.key ?? "",
      },
    },
  };
}

function buildDownsideFilteredIntentBatch(intents) {
  const base = {
    model: "current_paper_downside_subset_filter_v1",
    applied: intents.length > 0,
    exhaustive: intents.length <= MAX_DOWNSIDE_FILTER_INTENTS,
    candidateIntentCount: intents.length,
    evaluatedSubsetCount: 0,
    positiveTailCandidateCount: 0,
    selectedCount: intents.length,
    filteredCount: 0,
    selectedSymbols: intents.map((intent) => intentSymbol(intent)),
    baseline: intents.length > 0 ? evaluateDownsideCandidate(intents) : null,
    bestCandidate: null,
    tailPass: false,
    fallbackReason: "",
  };
  if (intents.length === 0) {
    return {
      intents,
      filter: { ...base, applied: false, fallbackReason: "no_candidate_intents" },
    };
  }
  if (intents.length > MAX_DOWNSIDE_FILTER_INTENTS) {
    return buildBoundedDownsideBeamFilter(intents, base);
  }

  let bestCandidate = null;
  let positiveTailCandidateCount = 0;
  let evaluatedSubsetCount = 0;
  const candidateBySymbols = new Map();
  for (let mask = 1; mask < 1 << intents.length; mask++) {
    const subset = intents.filter((_, index) => (mask & (1 << index)) !== 0);
    const candidate = evaluateDownsideCandidate(subset);
    evaluatedSubsetCount += 1;
    if (candidate.tailPass) {
      positiveTailCandidateCount += 1;
    }
    const key = candidate.symbols.join("|");
    candidateBySymbols.set(key, subset);
    bestCandidate = compareDownsideCandidate(bestCandidate, candidate);
  }

  const selectedSymbols = bestCandidate?.symbols ?? base.selectedSymbols;
  const selectedIntents = candidateBySymbols.get(selectedSymbols.join("|")) ?? intents;
  const tailPass = bestCandidate?.tailPass === true;
  return {
    intents: selectedIntents,
    filter: {
      ...base,
      evaluatedSubsetCount,
      positiveTailCandidateCount,
      selectedCount: selectedIntents.length,
      filteredCount: Math.max(0, intents.length - selectedIntents.length),
      selectedSymbols,
      bestCandidate,
      tailPass,
      fallbackReason: tailPass ? "" : "no_positive_tail_subset_selected_lowest_tail_loss",
    },
  };
}

function countIntentSafetyFlags(intents) {
  let historicalSnapshotCount = 0;
  let routeUnresolvedCount = 0;
  let paperExplorationOnlyCount = 0;
  let executionIneligibleCount = 0;
  let promotionBlockedIntentCount = 0;
  for (const intent of intents) {
    if (intent.historicalSnapshot === true) {
      historicalSnapshotCount += 1;
    }
    if (intent.resolverReady === false || intent.routeReady === false) {
      routeUnresolvedCount += 1;
    }
    if (intent.paperExplorationOnly === true) {
      paperExplorationOnlyCount += 1;
    }
    if (intent.executionEligible === false) {
      executionIneligibleCount += 1;
    }
    if (intent.promotionBlocked === true) {
      promotionBlockedIntentCount += 1;
    }
  }
  return {
    historicalSnapshotCount,
    routeUnresolvedCount,
    paperExplorationOnlyCount,
    executionIneligibleCount,
    promotionBlockedIntentCount,
  };
}

function intentIdentity(intent) {
  return String(intent.intentId || intent.symbol || "").toUpperCase();
}

function repairActionForReasons(reasons) {
  if (reasons.includes("route_not_ready") || reasons.includes("paper_route_blocked")) {
    return "resolve_fresh_matched_route_before_strategy_use";
  }
  if (reasons.includes("execution_ineligible") || reasons.includes("promotion_blocked")) {
    return "keep_paper_only_until_intent_execution_flags_are_clean";
  }
  if (reasons.includes("unknown_point_value")) {
    return "add_official_contract_point_value_before_risk_approval";
  }
  if (reasons.includes("over_max_risk")) {
    return "reduce_risk_pts_qty_or_notional_before_downside_filter";
  }
  if (reasons.includes("confidence_below_min")) {
    return "collect_more_fresh_ticks_or_wait_for_stronger_signal_confidence";
  }
  if (reasons.includes("risk_reward_below_min")) {
    return "widen_reward_or_tighten_stop_before_approval";
  }
  if (reasons.includes("downside_tail_filtered")) {
    return "combine_with_low_correlation_candidate_or_reduce_tail_loss";
  }
  return "no_repair_required";
}

function riskDiagnosticForIntent(intent, { currentIntentSource, maxRiskNotional, minConfidence }) {
  const riskNotional = intentRiskNotional(intent);
  const rewardNotional = intentRewardNotional(intent);
  const confidence = finiteNumber(intent.confidence);
  const riskRewardRatio = finiteNumber(intent.riskRewardRatio);
  const currency = intentCurrency(intent);
  const reasons = [];
  if (
    currentIntentSource &&
    (intent.routeReady !== true ||
      intent.resolverReady === false ||
      intent.paperExplorationOnly === true)
  ) {
    reasons.push(intent.paperExplorationOnly === true ? "paper_route_blocked" : "route_not_ready");
  }
  if (intent.executionEligible === false) {
    reasons.push("execution_ineligible");
  }
  if (intent.promotionBlocked === true) {
    reasons.push("promotion_blocked");
  }
  if (currency === "POINT") {
    reasons.push("unknown_point_value");
  }
  if (riskNotional === null || riskNotional <= 0) {
    reasons.push("risk_notional_missing");
  } else if (maxRiskNotional !== null && riskNotional > maxRiskNotional) {
    reasons.push("over_max_risk");
  }
  if (confidence === null || confidence < minConfidence) {
    reasons.push("confidence_below_min");
  }
  if (riskRewardRatio === null || riskRewardRatio < 1.5) {
    reasons.push("risk_reward_below_min");
  }
  return {
    symbol: intentSymbol(intent),
    intentId: String(intent.intentId ?? ""),
    targetId: String(intent.targetId ?? ""),
    marketCode: String(intent.marketCode ?? ""),
    side: String(intent.side ?? ""),
    direction: String(intent.direction ?? ""),
    riskPts: finiteNumber(intent.riskPts),
    rewardPts: finiteNumber(intent.rewardPts),
    qty: intentQuantity(intent),
    riskNotional,
    rewardNotional,
    currency,
    confidence,
    riskRewardRatio,
    routeReady: intent.routeReady === true,
    resolverReady: intent.resolverReady !== false,
    historicalSnapshot: intent.historicalSnapshot === true,
    paperExplorationOnly: intent.paperExplorationOnly === true,
    executionEligible: intent.executionEligible !== false,
    promotionBlocked: intent.promotionBlocked === true,
    sourceFreshnessStatus: String(intent.sourceEvent?.freshnessStatus ?? ""),
    sourceWallClockAgeSeconds: finiteNumber(
      intent.sourceEvent?.wallClockAgeSeconds ?? intent.meta?.confidenceInputs?.wallClockAgeSeconds,
    ),
    pointValueConfidence: String(
      intent.pointValueConfidence ?? intent.meta?.contractRisk?.confidence ?? "",
    ),
    tailPassFeasibility: tailPassFeasibilityForIntent(intent),
    reasons,
    repairAction: repairActionForReasons(reasons),
  };
}

function outcomeStatsFromRegistry(registry) {
  const outcomeStats =
    registry?.outcomeStats ??
    registry?.outcomes ??
    registry?.performance ??
    registry?.tailRiskOutcomeStats ??
    {};
  const counters = registry?.counters ?? {};
  const sampleCount = firstFiniteNumber(
    outcomeStats.sampleCount,
    outcomeStats.outcomeSampleCount,
    outcomeStats.closedTrades,
    outcomeStats.completedTrades,
    outcomeStats.totalOutcomes,
    counters.closedPaperTrades,
    counters.completedPaperTrades,
  );
  const stopHitCount = firstFiniteNumber(
    outcomeStats.stopHitCount,
    outcomeStats.stopHits,
    outcomeStats.losses,
    counters.stopHits,
  );
  const takeProfitHitCount = firstFiniteNumber(
    outcomeStats.takeProfitHitCount,
    outcomeStats.takeProfitHits,
    outcomeStats.wins,
    counters.takeProfitHits,
  );
  const stopHitRate =
    firstFiniteNumber(outcomeStats.stopHitRate, outcomeStats.lossRate) ??
    ratioOrNull(stopHitCount, sampleCount);
  const winRate =
    firstFiniteNumber(outcomeStats.winRate, outcomeStats.takeProfitHitRate) ??
    ratioOrNull(takeProfitHitCount, sampleCount);
  return {
    sampleCount: sampleCount ?? 0,
    stopHitCount: stopHitCount ?? 0,
    takeProfitHitCount: takeProfitHitCount ?? 0,
    stopHitRate,
    winRate,
    source: String(outcomeStats.source ?? ""),
    paperOnly: outcomeStats.paperOnly === true,
    simulatedOnly: outcomeStats.simulatedOnly === true,
    noLiveOrderSent: outcomeStats.noLiveOrderSent === true,
  };
}

function buildEmpiricalTailEvidence({ learningRegistry, learningRegistryPath }) {
  const counters = learningRegistry?.counters ?? {};
  const outcomeStats = outcomeStatsFromRegistry(learningRegistry);
  const registryPresent = learningRegistry && typeof learningRegistry === "object";
  const enoughSamples = outcomeStats.sampleCount >= MIN_EMPIRICAL_TAIL_OUTCOME_SAMPLES;
  const stopHitRate = finiteNumber(outcomeStats.stopHitRate);
  const stopHitRatePass = stopHitRate !== null && stopHitRate <= EMPIRICAL_STOP_HIT_RATE_THRESHOLD;
  const simulatedOnly = outcomeStats.simulatedOnly === true;
  const status = !registryPresent
    ? "blocked_learning_registry_missing"
    : !enoughSamples
      ? "blocked_insufficient_empirical_outcome_samples"
      : !stopHitRatePass
        ? "blocked_stop_hit_rate_over_tail_threshold"
        : simulatedOnly
          ? "ready_for_simulated_tail_calibration"
          : "ready_for_empirical_tail_calibration";
  const canCalibrateTailFeasibility = [
    "ready_for_empirical_tail_calibration",
    "ready_for_simulated_tail_calibration",
  ].includes(status);
  return {
    schema: "openclaw.capital.strategy-tail-empirical-evidence.v1",
    status,
    evidenceMode: simulatedOnly ? "paper_simulated_outcomes" : "paper_recorded_outcomes",
    sourcePath: learningRegistryPath,
    registryPresent: registryPresent === true,
    strategyName: String(learningRegistry?.strategyName ?? ""),
    learningStatus: String(learningRegistry?.status ?? ""),
    counters: {
      totalCycles: Number(counters.totalCycles ?? 0),
      paperIntents: Number(counters.paperIntents ?? 0),
      readinessBlocks: Number(counters.readinessBlocks ?? 0),
      consecutiveReadyCycles: Number(counters.consecutiveReadyCycles ?? 0),
      consecutiveReadinessBlocks: Number(counters.consecutiveReadinessBlocks ?? 0),
    },
    outcomeStats,
    requirements: {
      minOutcomeSamples: MIN_EMPIRICAL_TAIL_OUTCOME_SAMPLES,
      maxStopHitRate: EMPIRICAL_STOP_HIT_RATE_THRESHOLD,
      requiredFields: [
        "sampleCount",
        "stopHitCount or stopHitRate",
        "takeProfitHitCount or winRate",
      ],
    },
    canCalibrateTailFeasibility,
    liveCalibrationAllowed: false,
    conclusion:
      status === "ready_for_empirical_tail_calibration"
        ? "paper learning registry 已有足夠 outcome/stop-hit 統計，可作為 tail feasibility 校準證據。"
        : status === "ready_for_simulated_tail_calibration"
          ? "paper learning registry 已有足夠 simulated outcome/stop-hit 統計，可校準 paper tail feasibility；不得視為實盤成交證據。"
          : "paper learning registry 目前沒有足夠已平倉 outcome/stop-hit 統計；不得用 readiness blocks 或 paper intents 數量調高勝率。",
    noLiveOrderSent: true,
  };
}

function buildTailPassFeasibility(stats, empiricalTailEvidence) {
  const diagnostics = safeArray(stats?.risk_filter?.rejectedIntentDiagnostics);
  const selectedDiagnostics = diagnostics.filter((diagnostic) => diagnostic.selected === true);
  const infeasibleSelectedDiagnostics = selectedDiagnostics.filter(
    (diagnostic) => diagnostic.tailPassFeasibility?.feasibleWithCurrentConfidence !== true,
  );
  const requiredConfidenceValues = selectedDiagnostics
    .map((diagnostic) =>
      finiteNumber(diagnostic.tailPassFeasibility?.requiredConfidenceForPositiveP05),
    )
    .filter((value) => value !== null);
  const minRequiredConfidence =
    requiredConfidenceValues.length > 0 ? Math.min(...requiredConfidenceValues) : null;
  return {
    model: "current_paper_tail_pass_feasibility_v1",
    fillRateAssumption: DETERMINISTIC_FILL_RATE_ASSUMPTION,
    p05RequiresLossProbabilityBelow: 0.05,
    selectedSymbols: selectedDiagnostics.map((diagnostic) => diagnostic.symbol),
    selectedCount: selectedDiagnostics.length,
    infeasibleSelectedCount: infeasibleSelectedDiagnostics.length,
    minRequiredConfidenceForPositiveP05:
      minRequiredConfidence === null ? null : roundNumber(minRequiredConfidence, 6),
    sizingOnlyRepairCanPass: false,
    empiricalCalibrationStatus:
      empiricalTailEvidence?.status ?? "blocked_learning_registry_missing",
    empiricalCalibrationCanPass:
      empiricalTailEvidence?.canCalibrateTailFeasibility === true &&
      infeasibleSelectedDiagnostics.length > 0,
    empiricalTailEvidence,
    selectedDiagnostics: selectedDiagnostics.map((diagnostic) => ({
      symbol: diagnostic.symbol,
      intentId: diagnostic.intentId,
      riskPts: diagnostic.riskPts,
      rewardPts: diagnostic.rewardPts,
      riskNotional: diagnostic.riskNotional,
      confidence: diagnostic.confidence,
      tailPassFeasibility: diagnostic.tailPassFeasibility,
    })),
    conclusion:
      empiricalTailEvidence?.canCalibrateTailFeasibility === true
        ? "已有足夠 empirical outcome/stop-hit evidence；下一步可用同案例校準 tail simulation，但仍需重跑 p05 gate。"
        : infeasibleSelectedDiagnostics.length > 0
          ? "目前 selected paper intent 的 modeled loss probability 仍高於 5%；單純降低 riskNotional 只能縮小虧損，不能讓 p05 轉正。"
          : "selected paper intents 的 current confidence 已滿足 tail-pass feasibility；請重跑 promotion gate。",
    requiredEvidence:
      infeasibleSelectedDiagnostics.length > 0
        ? [
            "fresh empirical stop-hit evidence that lowers loss probability below 5%",
            "fresh resolved opposite or low-correlation paper candidates that improve aggregate p05",
            "same-case rerun with positive p05_total_pnl_pts and p05_total_pnl_notional",
          ]
        : ["same-case rerun with paper promotion gate"],
    noLiveOrderSent: true,
  };
}

function compactRepairCandidate(diagnostic) {
  return {
    symbol: diagnostic.symbol,
    intentId: diagnostic.intentId,
    status: diagnostic.status,
    reasons: safeArray(diagnostic.reasons),
    repairAction: diagnostic.repairAction,
    riskPts: diagnostic.riskPts,
    rewardPts: diagnostic.rewardPts,
    qty: diagnostic.qty,
    riskNotional: diagnostic.riskNotional,
    rewardNotional: diagnostic.rewardNotional,
    currency: diagnostic.currency,
    confidence: diagnostic.confidence,
    riskRewardRatio: diagnostic.riskRewardRatio,
    targetId: diagnostic.targetId,
    marketCode: diagnostic.marketCode,
    side: diagnostic.side,
    direction: diagnostic.direction,
    routeReady: diagnostic.routeReady === true,
    resolverReady: diagnostic.resolverReady !== false,
    historicalSnapshot: diagnostic.historicalSnapshot === true,
    paperExplorationOnly: diagnostic.paperExplorationOnly === true,
    executionEligible: diagnostic.executionEligible !== false,
    promotionBlocked: diagnostic.promotionBlocked === true,
    sourceFreshnessStatus: diagnostic.sourceFreshnessStatus,
    sourceWallClockAgeSeconds: diagnostic.sourceWallClockAgeSeconds,
    pointValueConfidence: diagnostic.pointValueConfidence,
    tailPassFeasibility: diagnostic.tailPassFeasibility,
  };
}

function diagnosticHasReason(diagnostic, reason) {
  return safeArray(diagnostic?.reasons).includes(reason);
}

function compareRepairCandidateDiagnostics(left, right) {
  const leftRisk = finiteNumber(left?.riskNotional) ?? Number.POSITIVE_INFINITY;
  const rightRisk = finiteNumber(right?.riskNotional) ?? Number.POSITIVE_INFINITY;
  if (leftRisk !== rightRisk) {
    return leftRisk - rightRisk;
  }
  const leftConfidence = finiteNumber(left?.confidence) ?? 0;
  const rightConfidence = finiteNumber(right?.confidence) ?? 0;
  if (rightConfidence !== leftConfidence) {
    return rightConfidence - leftConfidence;
  }
  return String(left?.symbol ?? "").localeCompare(String(right?.symbol ?? ""));
}

function diagnosticIdentity(diagnostic) {
  return String(diagnostic?.intentId || diagnostic?.symbol || "").toUpperCase();
}

function normalizedReplaySymbols(symbols) {
  return [
    ...new Set(
      safeArray(symbols)
        .map((symbol) => String(symbol ?? "").toUpperCase())
        .filter(Boolean),
    ),
  ].toSorted();
}

function failedReplayBasketKey(symbols) {
  return normalizedReplaySymbols(symbols).join("|");
}

function replayEvidenceForIntent(intent) {
  const sourceEvent = intent?.sourceEvent ?? {};
  return {
    symbol: intentSymbol(intent),
    targetId: String(intent?.targetId ?? ""),
    strategy: String(intent?.strategy ?? intent?.strategyName ?? ""),
    side: String(intent?.side ?? intent?.direction ?? ""),
    entryPrice: finiteNumber(intent?.entryPrice ?? intent?.price),
    stopPrice: finiteNumber(intent?.stopPrice ?? intent?.stopLoss),
    targetPrice: finiteNumber(intent?.targetPrice ?? intent?.takeProfit),
    riskPts: finiteNumber(intent?.riskPts),
    rewardPts: finiteNumber(intent?.rewardPts),
    riskNotional: intentRiskNotional(intent),
    confidence: finiteNumber(intent?.confidence),
    sourceReceivedAt: String(sourceEvent?.receivedAt ?? ""),
    source: String(sourceEvent?.source ?? ""),
    bid: finiteNumber(sourceEvent?.bid),
    ask: finiteNumber(sourceEvent?.ask),
    close: finiteNumber(sourceEvent?.close),
    priceScale: finiteNumber(sourceEvent?.priceScale),
  };
}

function failedReplayEvidenceDigestForIntents(intents) {
  const evidence = intents.map(replayEvidenceForIntent).toSorted((left, right) => {
    if (left.symbol !== right.symbol) {
      return left.symbol.localeCompare(right.symbol);
    }
    return left.targetId.localeCompare(right.targetId);
  });
  return sha256Text(JSON.stringify(evidence));
}

function emptyFailedReplayHistory() {
  return {
    schema: "openclaw.capital.strategy-tail-risk-failed-replay-history.v1",
    maxBaskets: FAILED_REPLAY_HISTORY_MAX_BASKETS,
    basketCount: 0,
    baskets: [],
    excludedSymbols: [],
    machineLine: "failedReplayHistory=baskets=0;excluded=none;maxBaskets=8;noOrderWrite=true",
  };
}

function buildFailedReplayHistory(baskets) {
  const byKey = new Map();
  for (const basket of safeArray(baskets)) {
    const symbols = normalizedReplaySymbols(basket?.symbols ?? basket);
    if (symbols.length === 0) {
      continue;
    }
    const evidenceDigest = String(basket?.evidenceDigest ?? "").toUpperCase();
    const key = `${failedReplayBasketKey(symbols)}#${evidenceDigest || "legacy"}`;
    byKey.delete(key);
    byKey.set(key, { symbols, evidenceDigest });
  }
  const limitedBaskets = [...byKey.values()].slice(-FAILED_REPLAY_HISTORY_MAX_BASKETS);
  const excludedSymbols = normalizedReplaySymbols(
    limitedBaskets.flatMap((basket) => basket.symbols),
  );
  return {
    schema: "openclaw.capital.strategy-tail-risk-failed-replay-history.v1",
    maxBaskets: FAILED_REPLAY_HISTORY_MAX_BASKETS,
    basketCount: limitedBaskets.length,
    baskets: limitedBaskets.map((basket, index) => ({
      index: index + 1,
      key: failedReplayBasketKey(basket.symbols),
      symbols: basket.symbols,
      evidenceDigest: basket.evidenceDigest,
    })),
    excludedSymbols,
    machineLine: `failedReplayHistory=baskets=${limitedBaskets.length};excluded=${excludedSymbols.join("|") || "none"};maxBaskets=${FAILED_REPLAY_HISTORY_MAX_BASKETS};evidenceDigests=${limitedBaskets.filter((basket) => basket.evidenceDigest).length};noOrderWrite=true`,
  };
}

function appendFailedReplayHistory(history, symbols, evidenceDigest = "") {
  return buildFailedReplayHistory([...safeArray(history?.baskets), { symbols, evidenceDigest }]);
}

function failedReplayHistoryFromPreviousReport(report) {
  const replay = report?.tailRiskRepair?.repairCandidateReplay;
  const existingHistory = replay?.failedReplayHistory;
  const baskets = safeArray(existingHistory?.baskets);
  if (replay?.status === "candidate_batch_replayed_still_blocked") {
    baskets.push({ symbols: replay.selectedSymbols });
  }
  return baskets.length > 0 ? buildFailedReplayHistory(baskets) : emptyFailedReplayHistory();
}

function emptyRepairCandidateReplay(replayMode = "not_evaluated") {
  return {
    schema: "openclaw.capital.strategy-tail-risk-repair-candidate-replay.v1",
    status: "not_evaluated",
    replayMode,
    sourceBucket: "fresh_resolved_low_correlation_or_opposite_exposure",
    selectedSymbols: [],
    selectedCandidateCount: 0,
    replayCandidate: null,
    currentCandidate: null,
    replayBetterThanCurrent: false,
    requiredPass: {
      p05_total_pnl_pts: ">0",
      p05_total_pnl_notional: ">0",
    },
    followUpCommand: "pnpm capital:trade:current-paper-intents",
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
    machineLine:
      "tailRepairReplay=not_evaluated;selected=none;p05=missing;p05Notional=missing;betterThanCurrent=false;noOrderWrite=true",
    failedReplayHistory: emptyFailedReplayHistory(),
  };
}

function failedReplaySymbolsFromPreviousReport(report) {
  return failedReplayHistoryFromPreviousReport(report).excludedSymbols;
}

function buildActiveFailedReplayExclusion({
  failedReplayHistory,
  intentByIdentity,
  replayDiagnosticPool,
}) {
  const excludedSymbols = [];
  const staleBaskets = [];
  const matchedBaskets = [];
  for (const basket of safeArray(failedReplayHistory?.baskets)) {
    const symbols = normalizedReplaySymbols(basket?.symbols);
    const evidenceDigest = String(basket?.evidenceDigest ?? "").toUpperCase();
    if (symbols.length === 0) {
      staleBaskets.push({ key: failedReplayBasketKey(symbols), reason: "empty_symbol_basket" });
      continue;
    }
    const symbolSet = new Set(symbols);
    const currentIntents = replayDiagnosticPool
      .filter((diagnostic) => symbolSet.has(String(diagnostic.symbol ?? "").toUpperCase()))
      .map((diagnostic) => intentByIdentity.get(diagnosticIdentity(diagnostic)))
      .filter(Boolean);
    if (currentIntents.length !== symbols.length) {
      staleBaskets.push({ key: failedReplayBasketKey(symbols), reason: "candidate_not_current" });
      continue;
    }
    if (!evidenceDigest) {
      matchedBaskets.push({ key: failedReplayBasketKey(symbols), symbols, evidenceDigest });
      excludedSymbols.push(...symbols);
      continue;
    }
    const currentDigest = failedReplayEvidenceDigestForIntents(currentIntents);
    if (currentDigest === evidenceDigest) {
      matchedBaskets.push({ key: failedReplayBasketKey(symbols), symbols, evidenceDigest });
      excludedSymbols.push(...symbols);
    } else {
      staleBaskets.push({ key: failedReplayBasketKey(symbols), reason: "quote_evidence_changed" });
    }
  }
  const activeExcludedSymbols = normalizedReplaySymbols(excludedSymbols);
  return {
    schema: "openclaw.capital.strategy-tail-risk-active-failed-replay-exclusion.v1",
    excludedSymbols: activeExcludedSymbols,
    matchedBasketCount: matchedBaskets.length,
    staleBasketCount: staleBaskets.length,
    matchedBaskets,
    staleBaskets,
    noOrderWrite: true,
    machineLine: `activeFailedReplayExclusion=matched:${matchedBaskets.length};stale:${staleBaskets.length};excluded=${activeExcludedSymbols.join("|") || "none"};noOrderWrite=true`,
  };
}

function buildTailRepairCandidateReplay({
  preDownsideIntents,
  selectedIntents,
  rejectedIntentDiagnostics,
  downsideFilter,
  failedReplayHistory = emptyFailedReplayHistory(),
}) {
  const intentByIdentity = new Map(
    preDownsideIntents.map((intent) => [intentIdentity(intent), intent]),
  );
  const replayDiagnosticPool = rejectedIntentDiagnostics
    .filter(
      (diagnostic) =>
        diagnostic.selected !== true && diagnosticHasReason(diagnostic, "downside_tail_filtered"),
    )
    .toSorted(compareRepairCandidateDiagnostics);
  const activeFailedReplayExclusion = buildActiveFailedReplayExclusion({
    failedReplayHistory,
    intentByIdentity,
    replayDiagnosticPool,
  });
  const excludedFailedReplaySymbolSet = new Set(activeFailedReplayExclusion.excludedSymbols);
  const skippedFailedReplayDiagnostics = replayDiagnosticPool.filter((diagnostic) =>
    excludedFailedReplaySymbolSet.has(String(diagnostic.symbol ?? "").toUpperCase()),
  );
  const replayDiagnostics = replayDiagnosticPool
    .filter(
      (diagnostic) =>
        !excludedFailedReplaySymbolSet.has(String(diagnostic.symbol ?? "").toUpperCase()),
    )
    .slice(0, 3);
  const replayIntents = replayDiagnostics
    .map((diagnostic) => intentByIdentity.get(diagnosticIdentity(diagnostic)))
    .filter(Boolean);
  if (replayIntents.length === 0) {
    const status =
      skippedFailedReplayDiagnostics.length > 0
        ? "blocked_no_new_repair_candidates_after_failed_replay"
        : "blocked_no_repair_candidates";
    return {
      ...emptyRepairCandidateReplay("same_case_diagnostic_candidate_batch"),
      status,
      excludedFailedReplaySymbols: [...excludedFailedReplaySymbolSet],
      skippedFailedReplayCandidateCount: skippedFailedReplayDiagnostics.length,
      availableAfterExclusionCount: replayDiagnostics.length,
      failedReplayHistory,
      activeFailedReplayExclusion,
      machineLine: `tailRepairReplay=${status};selected=none;p05=missing;p05Notional=missing;betterThanCurrent=false;excludedFailedReplay=${[...excludedFailedReplaySymbolSet].join("|") || "none"};skippedFailedReplay=${skippedFailedReplayDiagnostics.length};${activeFailedReplayExclusion.machineLine};noOrderWrite=true`,
    };
  }
  const currentCandidate =
    downsideFilter?.bestCandidate ??
    (selectedIntents.length > 0 ? evaluateDownsideCandidate(selectedIntents) : null);
  const replayCandidate = evaluateDownsideCandidate(replayIntents);
  const replayBetterThanCurrent =
    currentCandidate !== null &&
    (replayCandidate.p05_total_pnl_notional > currentCandidate.p05_total_pnl_notional ||
      replayCandidate.p05_total_pnl_pts > currentCandidate.p05_total_pnl_pts);
  const status =
    replayCandidate.tailPass === true
      ? "candidate_batch_tail_passed_requires_promotion_rerun"
      : "candidate_batch_replayed_still_blocked";
  const selectedSymbols = replayIntents.map((intent) => intentSymbol(intent));
  const replayEvidenceDigest = failedReplayEvidenceDigestForIntents(replayIntents);
  const nextFailedReplayHistory =
    status === "candidate_batch_replayed_still_blocked"
      ? appendFailedReplayHistory(failedReplayHistory, selectedSymbols, replayEvidenceDigest)
      : failedReplayHistory;
  return {
    schema: "openclaw.capital.strategy-tail-risk-repair-candidate-replay.v1",
    status,
    replayMode: "same_case_diagnostic_candidate_batch",
    sourceBucket: "fresh_resolved_low_correlation_or_opposite_exposure",
    selectedSymbols,
    selectedCandidateCount: replayIntents.length,
    excludedFailedReplaySymbols: [...excludedFailedReplaySymbolSet],
    skippedFailedReplayCandidateCount: skippedFailedReplayDiagnostics.length,
    availableAfterExclusionCount: replayDiagnostics.length,
    failedReplayHistory: nextFailedReplayHistory,
    activeFailedReplayExclusion,
    replayEvidenceDigest,
    replayCandidate,
    currentCandidate,
    replayBetterThanCurrent,
    requiredPass: {
      p05_total_pnl_pts: ">0",
      p05_total_pnl_notional: ">0",
    },
    followUpCommand:
      status === "candidate_batch_tail_passed_requires_promotion_rerun"
        ? "pnpm capital:strategy:fill-simulation:check"
        : "pnpm capital:trade:current-paper-intents",
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
    machineLine: `tailRepairReplay=${status};selected=${selectedSymbols.join("|") || "none"};p05=${replayCandidate.p05_total_pnl_pts};p05Notional=${replayCandidate.p05_total_pnl_notional};betterThanCurrent=${replayBetterThanCurrent};excludedFailedReplay=${[...excludedFailedReplaySymbolSet].join("|") || "none"};skippedFailedReplay=${skippedFailedReplayDiagnostics.length};failedReplayHistoryCount=${nextFailedReplayHistory.basketCount};replayEvidenceDigest=${replayEvidenceDigest};${activeFailedReplayExclusion.machineLine};noOrderWrite=true`,
  };
}

function buildRepairCandidatePlan(stats, empiricalTailEvidence) {
  const diagnostics = safeArray(stats?.risk_filter?.rejectedIntentDiagnostics);
  const selectedNeedsConfidence = diagnostics.filter(
    (diagnostic) =>
      diagnostic.selected === true &&
      diagnostic.tailPassFeasibility?.feasibleWithCurrentConfidence !== true,
  );
  const downsideFilteredLowCorrelationCandidates = diagnostics.filter(
    (diagnostic) =>
      diagnostic.selected !== true && diagnosticHasReason(diagnostic, "downside_tail_filtered"),
  );
  const overMaxRiskCandidates = diagnostics.filter((diagnostic) =>
    diagnosticHasReason(diagnostic, "over_max_risk"),
  );
  const unknownPointValueCandidates = diagnostics.filter((diagnostic) =>
    diagnosticHasReason(diagnostic, "unknown_point_value"),
  );
  const planStatus =
    selectedNeedsConfidence.length > 0
      ? "blocked_selected_intents_need_tail_evidence"
      : downsideFilteredLowCorrelationCandidates.length > 0
        ? "candidate_refresh_available"
        : overMaxRiskCandidates.length > 0 || unknownPointValueCandidates.length > 0
          ? "candidate_contract_repair_required"
          : "same_case_rerun_required";
  const outcomeStats = empiricalTailEvidence?.outcomeStats ?? {};
  const requirements = empiricalTailEvidence?.requirements ?? {};
  return {
    schema: "openclaw.capital.strategy-tail-risk-repair-candidate-plan.v1",
    status: planStatus,
    source: "risk_filter.rejectedIntentDiagnostics",
    totalDiagnostics: diagnostics.length,
    selectedNeedsConfidence: selectedNeedsConfidence.map(compactRepairCandidate),
    downsideFilteredLowCorrelationCandidates:
      downsideFilteredLowCorrelationCandidates.map(compactRepairCandidate),
    overMaxRiskCandidates: overMaxRiskCandidates.map(compactRepairCandidate),
    unknownPointValueCandidates: unknownPointValueCandidates.map(compactRepairCandidate),
    empiricalStopHitCalibration: {
      status: empiricalTailEvidence?.status ?? "blocked_learning_registry_missing",
      canCalibrateTailFeasibility: empiricalTailEvidence?.canCalibrateTailFeasibility === true,
      sampleCount: Number(outcomeStats.sampleCount ?? 0),
      stopHitRate: finiteNumber(outcomeStats.stopHitRate),
      maxStopHitRate: finiteNumber(requirements.maxStopHitRate),
      minOutcomeSamples: Number(requirements.minOutcomeSamples ?? 0),
      nextAction:
        empiricalTailEvidence?.canCalibrateTailFeasibility === true
          ? "rerun_same_case_tail_simulation_with_empirical_stop_hit_calibration"
          : "collect_paper_outcome_samples_until_stop_hit_rate_gate_passes",
      noLiveOrderSent: true,
    },
    sameCaseRerun: {
      command: "pnpm capital:strategy:fill-simulation:check",
      replayStatus: stats?.risk_filter?.repairCandidateReplay?.status ?? "not_evaluated",
      replayMachineLine: stats?.risk_filter?.repairCandidateReplay?.machineLine ?? "",
      requiredEvidence: [
        "positive p05_total_pnl_pts",
        "positive p05_total_pnl_notional",
        "paper promotion gate remains order-write disabled",
      ],
      noLiveOrderSent: true,
    },
    safetyLock: {
      paperOnly: true,
      noLiveOrderSent: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      promoteLiveAutomatically: false,
    },
    machineLine: `repairCandidatePlan=${planStatus};selectedNeedsConfidence=${selectedNeedsConfidence.length};downsideFiltered=${downsideFilteredLowCorrelationCandidates.length};overMaxRisk=${overMaxRiskCandidates.length};unknownPointValue=${unknownPointValueCandidates.length};noOrderWrite=true`,
  };
}

function buildRiskDiagnostics(intents, selectedIntents, options) {
  const selectedIdentities = new Set(selectedIntents.map((intent) => intentIdentity(intent)));
  return intents.map((intent) => {
    const diagnostic = riskDiagnosticForIntent(intent, options);
    const selected = selectedIdentities.has(intentIdentity(intent));
    const reasons =
      selected || diagnostic.reasons.length > 0 ? diagnostic.reasons : ["downside_tail_filtered"];
    return {
      ...diagnostic,
      selected,
      status: selected
        ? "selected_for_simulation"
        : diagnostic.reasons.length > 0
          ? "blocked_before_downside_filter"
          : "filtered_by_downside_subset",
      reasons,
      repairAction: selected ? "no_repair_required" : repairActionForReasons(reasons),
    };
  });
}

function buildRiskApprovedIntentBatch(intents, source, options = {}) {
  const currentIntentSource =
    source?.sourceKind === "primary_current" || source?.sourceKind === "generated_current";
  const routeReadyIntents = intents.filter(
    (intent) =>
      intent.routeReady === true &&
      intent.resolverReady !== false &&
      intent.executionEligible !== false &&
      intent.paperExplorationOnly !== true &&
      intent.promotionBlocked !== true,
  );
  const eligibleIntents =
    currentIntentSource && routeReadyIntents.length > 0 ? routeReadyIntents : intents;
  const knownPointValueIntents = eligibleIntents.filter(
    (intent) => intentCurrency(intent) !== "POINT",
  );
  const riskBasisIntents =
    knownPointValueIntents.length > 0 ? knownPointValueIntents : eligibleIntents;
  const riskValues = riskBasisIntents
    .map((intent) => intentRiskNotional(intent))
    .filter((value) => value !== null && value > 0)
    .toSorted((a, b) => a - b);
  const currencies = [
    ...new Set(eligibleIntents.map((intent) => intentCurrency(intent))),
  ].toSorted();
  const unknownPointValueEligibleCount = eligibleIntents.filter(
    (intent) => intentCurrency(intent) === "POINT",
  ).length;
  const filterBase = {
    model: "current_paper_point_value_risk_overlay_v1",
    applied: currentIntentSource,
    source_intent_count: intents.length,
    eligible_intent_count: eligibleIntents.length,
    approved_intent_count: eligibleIntents.length,
    filtered_intent_count: Math.max(0, intents.length - eligibleIntents.length),
    maxRiskNotional: null,
    medianRiskNotional: null,
    p75RiskNotional: null,
    minConfidence: currentIntentSource ? 0.55 : 0,
    currencySet: currencies,
    mixedCurrency: currencies.length > 1,
    unknownPointValueEligibleCount,
    unknownPointValueFilteredCount: 0,
    fallbackReason: "",
    warning: currencies.length > 1 ? "mixed_currency_notional_proxy" : "",
    preDownsideApprovedIntentCount: eligibleIntents.length,
    downsideFilteredIntentCount: 0,
    rejectedIntentDiagnostics: [],
    actionableRepairCandidates: [],
    repairCandidateReplay: emptyRepairCandidateReplay(
      currentIntentSource ? "pre_downside_not_applied" : "not_current_paper_source",
    ),
    downsideFilter: {
      model: "current_paper_downside_subset_filter_v1",
      applied: false,
      exhaustive: eligibleIntents.length <= MAX_DOWNSIDE_FILTER_INTENTS,
      candidateIntentCount: eligibleIntents.length,
      evaluatedSubsetCount: 0,
      positiveTailCandidateCount: 0,
      selectedCount: eligibleIntents.length,
      filteredCount: 0,
      selectedSymbols: eligibleIntents.map((intent) => intentSymbol(intent)),
      baseline: null,
      bestCandidate: null,
      tailPass: false,
      fallbackReason: currentIntentSource ? "" : "not_current_paper_source",
    },
  };
  if (!currentIntentSource || riskValues.length === 0) {
    return { intents: eligibleIntents, filter: filterBase };
  }

  const medianRiskNotional = percentile(riskValues, 0.5);
  const p75RiskNotional = percentile(riskValues, 0.75);
  const maxRiskNotional = roundNumber(
    Math.max(
      CURRENT_PAPER_MAX_RISK_NOTIONAL_FLOOR,
      Math.max(medianRiskNotional * 3, p75RiskNotional * 1.5),
    ),
  );
  const minConfidence = 0.55;
  const approvedIntents = eligibleIntents.filter((intent) => {
    const riskNotional = intentRiskNotional(intent);
    const confidence = finiteNumber(intent.confidence);
    const riskRewardRatio = finiteNumber(intent.riskRewardRatio);
    const pointValueKnown = intentCurrency(intent) !== "POINT";
    return (
      riskNotional !== null &&
      riskNotional <= maxRiskNotional &&
      pointValueKnown &&
      confidence !== null &&
      confidence >= minConfidence &&
      riskRewardRatio !== null &&
      riskRewardRatio >= 1.5
    );
  });
  const preDownsideIntents =
    approvedIntents.length > 0
      ? approvedIntents
      : knownPointValueIntents.length > 0
        ? knownPointValueIntents
        : eligibleIntents;
  const tailControlledPreDownsideIntents = preDownsideIntents.filter(
    (intent) => tailRiskControlsForIntent(intent) !== null,
  );
  const downsideInputIntents =
    currentIntentSource && tailControlledPreDownsideIntents.length > 0
      ? tailControlledPreDownsideIntents
      : preDownsideIntents;
  const tailControlFilteredIntentCount =
    downsideInputIntents === tailControlledPreDownsideIntents
      ? Math.max(0, preDownsideIntents.length - downsideInputIntents.length)
      : 0;
  const downsideBatch = buildDownsideFilteredIntentBatch(downsideInputIntents);
  const selectedIntents = downsideBatch.intents;
  const rejectedIntentDiagnostics = buildRiskDiagnostics(eligibleIntents, selectedIntents, {
    currentIntentSource,
    maxRiskNotional,
    minConfidence,
  });
  const repairCandidateReplay = buildTailRepairCandidateReplay({
    preDownsideIntents,
    selectedIntents,
    rejectedIntentDiagnostics,
    downsideFilter: downsideBatch.filter,
    excludedFailedReplaySymbols: options.excludedFailedReplaySymbols,
    failedReplayHistory: options.failedReplayHistory,
  });
  return {
    intents: selectedIntents,
    filter: {
      ...filterBase,
      approved_intent_count: selectedIntents.length,
      filtered_intent_count: Math.max(0, intents.length - selectedIntents.length),
      preDownsideApprovedIntentCount: preDownsideIntents.length,
      tailControlledIntentCount: tailControlledPreDownsideIntents.length,
      tailControlFilteredIntentCount,
      downsideFilteredIntentCount: downsideBatch.filter.filteredCount,
      unknownPointValueFilteredCount: Math.max(
        0,
        unknownPointValueEligibleCount -
          selectedIntents.filter((intent) => intentCurrency(intent) === "POINT").length,
      ),
      maxRiskNotional,
      medianRiskNotional,
      p75RiskNotional,
      minConfidence,
      rejectedIntentDiagnostics,
      actionableRepairCandidates: rejectedIntentDiagnostics.filter(
        (diagnostic) => diagnostic.selected !== true,
      ),
      repairCandidateReplay,
      downsideFilter: downsideBatch.filter,
      fallbackReason:
        approvedIntents.length > 0
          ? downsideBatch.filter.fallbackReason
          : knownPointValueIntents.length > 0
            ? "risk_filter_empty_known_point_value_candidates_only"
            : "risk_filter_empty",
    },
  };
}

function buildPromotionGate({
  currentPaperIntentsReady,
  source,
  stats,
  monteCarlo,
  recommendation,
}) {
  const totalIntents = Number(stats?.total_intents ?? 0);
  const historicalSnapshotCount = Number(stats?.historical_snapshot_count ?? 0);
  const routeUnresolvedCount = Number(stats?.route_unresolved_count ?? 0);
  const paperExplorationOnlyCount = Number(stats?.paper_exploration_only_count ?? 0);
  const executionIneligibleCount = Number(stats?.execution_ineligible_count ?? 0);
  const promotionBlockedIntentCount = Number(stats?.promotion_blocked_intent_count ?? 0);
  const expectedValuePts = Number(stats?.expected_value_pts ?? 0);
  const fillRate = Number(stats?.evidence_fill_rate ?? stats?.fill_rate ?? 0);
  const winRate = Number(stats?.evidence_win_rate ?? stats?.win_rate ?? 0);
  const p05TotalPnlPts = Number(monteCarlo?.p05_total_pnl_pts ?? 0);
  const sourceIsPrimary = source?.fallbackUsed !== true;
  const generatedCurrentFallback =
    source?.sourceKind === "generated_current" ||
    String(source?.fallbackReason ?? "").includes("generated_current");
  const currentIntentSourceUsable = sourceIsPrimary || generatedCurrentFallback;
  const checks = [
    {
      id: "has_current_intents",
      pass: totalIntents > 0,
      value: totalIntents,
      required: ">0",
    },
    {
      id: "primary_current_intents",
      pass: currentIntentSourceUsable,
      value: {
        source_kind: source?.sourceKind ?? "",
        fallback_reason: source?.fallbackReason ?? "",
      },
      required: "primary_current_or_generated_current",
    },
    {
      id: "no_historical_snapshot",
      pass: historicalSnapshotCount === 0,
      value: historicalSnapshotCount,
      required: 0,
    },
    {
      id: "route_resolved_for_paper_execution",
      pass: routeUnresolvedCount === 0 && paperExplorationOnlyCount === 0,
      value: {
        route_unresolved_count: routeUnresolvedCount,
        paper_exploration_only_count: paperExplorationOnlyCount,
      },
      required: 0,
    },
    {
      id: "execution_eligible_intents",
      pass: executionIneligibleCount === 0,
      value: executionIneligibleCount,
      required: 0,
    },
    {
      id: "intent_promotion_unblocked",
      pass: promotionBlockedIntentCount === 0,
      value: promotionBlockedIntentCount,
      required: 0,
    },
    {
      id: "expected_value_positive",
      pass: expectedValuePts > 0,
      value: expectedValuePts,
      required: ">0",
    },
    {
      id: "fill_rate_threshold",
      pass: fillRate >= 0.5,
      value: fillRate,
      required: ">=0.5",
    },
    {
      id: "win_rate_threshold",
      pass: winRate >= 0.48,
      value: winRate,
      required: ">=0.48",
    },
    {
      id: "tail_risk_positive",
      pass: p05TotalPnlPts > 0,
      value: p05TotalPnlPts,
      required: ">0",
    },
  ];
  const blockedReasons = checks.filter((check) => check.pass !== true).map((check) => check.id);
  const paperPromotionEligible =
    blockedReasons.length === 0 &&
    currentPaperIntentsReady === true &&
    recommendation === "promote";
  const status = paperPromotionEligible ? "ready_for_paper_promotion" : "blocked";
  const blockedReasonText = blockedReasons.join("|") || "none";
  const nextSafeTask =
    status === "ready_for_paper_promotion"
      ? "執行 pnpm capital:paper-hft:promotion:check；仍不得送真單。"
      : blockedReasonText === "tail_risk_positive"
        ? "目前 current paper basket 的 p05 仍為負；先補 fresh resolved 低相關/反向候選，或等 stop-hit outcome 證據降到門檻後重跑 capital:strategy:fill-simulation:check；只降低單筆風險不能單獨解除 p05。"
        : `先修正 strategy fill promotion blockers: ${blockedReasonText}；仍不得送真單。`;
  return {
    schema: "openclaw.capital.strategy-fill-promotion-gate.v1",
    status,
    currentPaperIntentsReady: currentPaperIntentsReady === true,
    sourceIsPrimary,
    generatedCurrentFallback,
    fallbackUsed: source?.fallbackUsed === true,
    fallbackReason: source?.fallbackReason ?? "",
    paperPromotionEligible,
    liveTradingEnabled: false,
    writeBrokerOrders: false,
    noLiveOrderSent: true,
    recommendation,
    checks,
    blockedReasons,
    nextSafeTask,
    machineLine: `strategyFillPromotionGate=${status};blockedReasons=${blockedReasonText};paperPromotionEligible=${paperPromotionEligible};noOrderWrite=true`,
  };
}

function buildTailRiskRepair({ stats, monteCarlo, promotionGate, empiricalTailEvidence }) {
  const downsideFilter = stats?.risk_filter?.downsideFilter ?? {};
  const p05Pts = Number(monteCarlo?.p05_total_pnl_pts ?? 0);
  const p05Notional = Number(monteCarlo?.p05_total_pnl_notional ?? 0);
  const tailBlocked =
    safeArray(promotionGate?.blockedReasons).includes("tail_risk_positive") ||
    p05Pts <= 0 ||
    p05Notional <= 0;
  const status = tailBlocked ? "blocked_no_positive_tail_candidate" : "tail_risk_passed";
  const positiveTailCandidateCount = Number(downsideFilter.positiveTailCandidateCount ?? 0);
  return {
    schema: "openclaw.capital.strategy-tail-risk-repair.v1",
    status,
    blocker: tailBlocked ? "tail_risk_positive" : "",
    currentP05Pts: p05Pts,
    currentP05Notional: p05Notional,
    selectedSymbols: safeArray(downsideFilter.selectedSymbols),
    candidateIntentCount: Number(downsideFilter.candidateIntentCount ?? 0),
    evaluatedSubsetCount: Number(downsideFilter.evaluatedSubsetCount ?? 0),
    positiveTailCandidateCount,
    rejectedIntentDiagnostics: safeArray(stats?.risk_filter?.rejectedIntentDiagnostics),
    actionableRepairCandidates: safeArray(stats?.risk_filter?.actionableRepairCandidates),
    repairCandidateReplay: stats?.risk_filter?.repairCandidateReplay ?? null,
    tailPassFeasibility: buildTailPassFeasibility(stats, empiricalTailEvidence),
    repairCandidatePlan: buildRepairCandidatePlan(stats, empiricalTailEvidence),
    bestCandidate: downsideFilter.bestCandidate ?? null,
    baseline: downsideFilter.baseline ?? null,
    conclusion: tailBlocked
      ? "目前 current paper 候選沒有任何子集合可讓 Monte Carlo p05 轉正；不能 promotion，也不能用合成對沖或放寬風控假裝通過。"
      : "tail risk gate 已通過；仍需後續 promotion/canary/rollback gate。",
    recommendedRepair: tailBlocked
      ? {
          action: "collect_more_fresh_resolved_candidates_or_reduce_single_trade_tail_risk",
          requiredEvidence: [
            "fresh resolved candidate with opposite or low-correlation exposure",
            "known contract point value and non-POINT risk currency",
            "same-case rerun with positive p05_total_pnl_pts and p05_total_pnl_notional",
          ],
          forbiddenShortcut:
            "不得合成不存在的 hedge intent、不得降低 tail_risk_positive 門檻、不得送真單。",
        }
      : {
          action: "rerun_promotion_gate",
          requiredEvidence: ["paper promotion gate", "canary", "rollback"],
          forbiddenShortcut: "不得跳過 live promotion gate。",
        },
    safetyLock: {
      paperOnly: true,
      noLiveOrderSent: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      promoteLiveAutomatically: false,
    },
    machineLine: `tailRiskRepair=${status};positiveTailCandidates=${positiveTailCandidateCount};p05=${p05Pts};p05Notional=${p05Notional};repairReplay=${stats?.risk_filter?.repairCandidateReplay?.status ?? "missing"};noOrderWrite=true`,
    nextSafeTask: tailBlocked
      ? "補 fresh resolved 低相關/反向 paper candidate，或等 paper outcome stopHitRate <= 0.05 後重跑策略 fill；仍不得送真單。"
      : "重跑 paper promotion gate；仍不得送真單。",
  };
}

/**
 * @param {object} options
 * @param {string} [options.repoRoot]
 * @param {string} [options.intentsPath]
 * @param {string} [options.outputPath]
 * @param {string} [options.learningRegistryPath]
 */
export async function runStrategyFillSimulation(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const defaultIntentsPath = path.join(
    repoRoot,
    ".openclaw",
    "trading",
    "capital-paper-intents.jsonl",
  );
  const intentsPath = options.intentsPath ?? defaultIntentsPath;
  const fallbackIntentsPath =
    options.fallbackIntentsPath ??
    path.join(repoRoot, ".openclaw", "trading", "capital-strategy-intents.jsonl");
  const generatedCurrentIntentsPath =
    options.generatedCurrentIntentsPath ??
    path.join(
      repoRoot,
      ".openclaw",
      "trading",
      "capital-current-paper-intents-from-target-registry.jsonl",
    );
  const outputPath =
    options.outputPath ??
    path.join(repoRoot, ".openclaw", "trading", "capital-strategy-fill-simulation.json");
  const previousFillReport = await readJsonIfExists(outputPath);
  const failedReplayHistory = failedReplayHistoryFromPreviousReport(previousFillReport);
  const excludedFailedReplaySymbols = failedReplaySymbolsFromPreviousReport(previousFillReport);
  const learningRegistryPath =
    options.learningRegistryPath ??
    path.join(repoRoot, ".openclaw", "trading", "capital-paper-learning-registry.json");
  const learningRegistry = await readJsonIfExists(learningRegistryPath);
  const empiricalTailEvidence = buildEmpiricalTailEvidence({
    learningRegistry,
    learningRegistryPath,
  });
  const monteCarloIterations = Number.isFinite(Number(options.monteCarloIterations))
    ? Math.max(1, Math.floor(Number(options.monteCarloIterations)))
    : DEFAULT_MONTE_CARLO_ITERATIONS;
  const generatedAt = new Date().toISOString();

  // 讀取 intents
  const source = await readIntentSource(
    intentsPath,
    generatedCurrentIntentsPath,
    fallbackIntentsPath,
    {
      allowGeneratedCurrentOverride: path.resolve(intentsPath) === path.resolve(defaultIntentsPath),
    },
  );
  const lines = source.lines;
  if (lines.length === 0) {
    const stats = {
      total_intents: 0,
      filled_count: 0,
      fill_rate: 0,
      total_pnl_pts: 0,
      total_pnl_notional: 0,
      avg_pnl_pts: 0,
      avg_pnl_notional: 0,
      sharpe_proxy: 0,
      win_rate: 0,
      win_streak_max: 0,
      loss_streak_max: 0,
      expected_value_pts: 0,
      expected_value_notional: 0,
      by_strategy: {},
      invalid_intent_count: 0,
      normalized_legacy_alias_count: 0,
      blocked_legacy_alias_count: 0,
      historical_snapshot_count: 0,
      route_unresolved_count: 0,
      paper_exploration_only_count: 0,
      execution_ineligible_count: 0,
      promotion_blocked_intent_count: 0,
      source_intent_count: 0,
      risk_approved_intent_count: 0,
      risk_filtered_intent_count: 0,
      downside_filtered_intent_count: 0,
      max_risk_notional: 0,
      currency_set: [],
      source_historical_snapshot_count: 0,
      source_route_unresolved_count: 0,
      source_paper_exploration_only_count: 0,
      source_execution_ineligible_count: 0,
      source_promotion_blocked_intent_count: 0,
      risk_filter: {
        model: "current_paper_point_value_risk_overlay_v1",
        applied: false,
        source_intent_count: 0,
        eligible_intent_count: 0,
        approved_intent_count: 0,
        filtered_intent_count: 0,
        maxRiskNotional: null,
        medianRiskNotional: null,
        p75RiskNotional: null,
        minConfidence: 0,
        currencySet: [],
        mixedCurrency: false,
        unknownPointValueEligibleCount: 0,
        unknownPointValueFilteredCount: 0,
        fallbackReason: "",
        warning: "",
        preDownsideApprovedIntentCount: 0,
        downsideFilteredIntentCount: 0,
        downsideFilter: {
          model: "current_paper_downside_subset_filter_v1",
          applied: false,
          exhaustive: true,
          candidateIntentCount: 0,
          evaluatedSubsetCount: 0,
          positiveTailCandidateCount: 0,
          selectedCount: 0,
          filteredCount: 0,
          selectedSymbols: [],
          baseline: null,
          bestCandidate: null,
          tailPass: false,
          fallbackReason: "no_candidate_intents",
        },
      },
    };
    const monteCarlo = {
      iterations: monteCarloIterations,
      p05_total_pnl_pts: 0,
      p50_total_pnl_pts: 0,
      p95_total_pnl_pts: 0,
      p05_total_pnl_notional: 0,
      p50_total_pnl_notional: 0,
      p95_total_pnl_notional: 0,
      positive_rate: 0,
      positive_notional_rate: 0,
      worst_total_pnl_pts: 0,
      best_total_pnl_pts: 0,
      worst_total_pnl_notional: 0,
      best_total_pnl_notional: 0,
    };
    const promotionGate = buildPromotionGate({
      currentPaperIntentsReady: false,
      source,
      stats,
      monteCarlo,
      recommendation: "hold",
    });
    const report = {
      schema: SCHEMA,
      generatedAt,
      status: "no_intents",
      recommendation: "hold",
      source: {
        intentsPath,
        generatedCurrentIntentsPath,
        fallbackIntentsPath,
        fallbackUsed: source.fallbackUsed,
        sourceKind: source.sourceKind ?? "",
        fallbackReason: source.fallbackReason,
      },
      stats,
      monteCarlo,
      promotionGate,
      empiricalTailEvidence,
      safetyLock: baseSafetyLock(),
    };
    await writeJsonWithSha(outputPath, report);
    return report;
  }

  const parsedIntents = [];
  let invalidIntentCount = 0;
  let blockedLegacyAliasCount = 0;
  let unsafeIntentCount = 0;
  let historicalSnapshotCount = 0;
  let routeUnresolvedCount = 0;
  let paperExplorationOnlyCount = 0;
  let executionIneligibleCount = 0;
  let promotionBlockedIntentCount = 0;
  for (const line of lines) {
    try {
      const intent = normalizeIntent(JSON.parse(line));
      if (intent.invalidLegacySymbol) {
        blockedLegacyAliasCount += 1;
        continue;
      }
      if (
        intent.allowLiveTrading === true ||
        intent.writeBrokerOrders === true ||
        intent.promoteLiveAuto === true
      ) {
        unsafeIntentCount += 1;
      }
      if (intent.historicalSnapshot === true) {
        historicalSnapshotCount += 1;
      }
      if (intent.resolverReady === false || intent.routeReady === false) {
        routeUnresolvedCount += 1;
      }
      if (intent.paperExplorationOnly === true) {
        paperExplorationOnlyCount += 1;
      }
      if (intent.executionEligible === false) {
        executionIneligibleCount += 1;
      }
      if (intent.promotionBlocked === true) {
        promotionBlockedIntentCount += 1;
      }
      parsedIntents.push(intent);
    } catch {
      invalidIntentCount += 1;
    }
  }
  if (unsafeIntentCount > 0) {
    throw new Error(`unsafe strategy intents found: ${unsafeIntentCount}`);
  }
  const sourceHistoricalSnapshotCount = historicalSnapshotCount;
  const sourceRouteUnresolvedCount = routeUnresolvedCount;
  const sourcePaperExplorationOnlyCount = paperExplorationOnlyCount;
  const sourceExecutionIneligibleCount = executionIneligibleCount;
  const sourcePromotionBlockedIntentCount = promotionBlockedIntentCount;
  const riskBatch = buildRiskApprovedIntentBatch(parsedIntents, source, {
    excludedFailedReplaySymbols,
    failedReplayHistory,
  });
  const simulationIntents = riskBatch.intents;
  const activeSafetyCounts = countIntentSafetyFlags(simulationIntents);
  historicalSnapshotCount = activeSafetyCounts.historicalSnapshotCount;
  routeUnresolvedCount = activeSafetyCounts.routeUnresolvedCount;
  paperExplorationOnlyCount = activeSafetyCounts.paperExplorationOnlyCount;
  executionIneligibleCount = activeSafetyCounts.executionIneligibleCount;
  promotionBlockedIntentCount = activeSafetyCounts.promotionBlockedIntentCount;
  const pnlValues = [];
  const pnlNotionalValues = [];
  let filled_count = 0;
  let win_streak = 0,
    loss_streak = 0;
  let win_streak_max = 0,
    loss_streak_max = 0;
  let winCount = 0;

  const byStrategy = {};

  for (let index = 0; index < simulationIntents.length; index++) {
    const intent = simulationIntents[index];
    const result = simulateIntent(intent, index);
    pnlValues.push(result.pnlPts);
    pnlNotionalValues.push(result.pnlNotional);

    const st = intent.strategy ?? "unknown";
    if (!byStrategy[st]) {
      byStrategy[st] = { count: 0, filled: 0, wins: 0, pnlPts: 0, pnlNotional: 0 };
    }
    byStrategy[st].count++;

    if (result.filled) {
      filled_count++;
      byStrategy[st].filled++;
      if (result.win) {
        winCount++;
        byStrategy[st].wins++;
        byStrategy[st].pnlPts += result.pnlPts;
        byStrategy[st].pnlNotional += result.pnlNotional;
        loss_streak_max = Math.max(loss_streak_max, loss_streak);
        loss_streak = 0;
        win_streak++;
        win_streak_max = Math.max(win_streak_max, win_streak);
      } else {
        byStrategy[st].pnlPts += result.pnlPts;
        byStrategy[st].pnlNotional += result.pnlNotional;
        win_streak_max = Math.max(win_streak_max, win_streak);
        win_streak = 0;
        loss_streak++;
        loss_streak_max = Math.max(loss_streak_max, loss_streak);
      }
    }
  }

  win_streak_max = Math.max(win_streak_max, win_streak);
  loss_streak_max = Math.max(loss_streak_max, loss_streak);

  const total_intents = simulationIntents.length;
  const pnlPointDecimals = pnlDecimalsForIntents(simulationIntents);
  const pnlSummary = summarizePnl(pnlValues, pnlPointDecimals);
  const pnlNotionalSummary = summarizePnl(pnlNotionalValues);
  const total_pnl_pts = pnlSummary.total;
  const total_pnl_notional = pnlNotionalSummary.total;
  const avg_pnl_pts = pnlSummary.avg;
  const avg_pnl_notional = pnlNotionalSummary.avg;
  const win_rate = filled_count > 0 ? Math.round((winCount / filled_count) * 10000) / 10000 : 0;
  const fill_rate =
    total_intents > 0 ? Math.round((filled_count / total_intents) * 10000) / 10000 : 0;
  const sharpe_proxy = pnlSummary.sharpe_proxy;
  const monteCarlo = runMonteCarlo(simulationIntents, monteCarloIterations);
  const evidenceFillRate = Number(monteCarlo.fill_rate ?? fill_rate);
  const evidenceWinRate = Number(monteCarlo.win_rate ?? win_rate);

  // 期望值（按策略加權平均 R:R × 勝率）
  let evSum = 0;
  let evNotionalSum = 0;
  for (const intent of simulationIntents) {
    const st = intent.strategy ?? "default";
    const prior = STRATEGY_PRIORS[st] ?? STRATEGY_PRIORS.default;
    const conf = Number(intent.confidence) || prior.winRate;
    const wr = conf * 0.5 + prior.winRate * 0.5;
    const rp = Number(intent.rewardPts) || 1;
    const rk = Number(intent.riskPts) || 1;
    const evPts = wr * rp - (1 - wr) * rk;
    evSum += evPts;
    evNotionalSum += evPts * intentPointValue(intent) * intentQuantity(intent);
  }
  const expected_value_pts =
    total_intents > 0 ? roundNumber(evSum / total_intents, pnlPointDecimals) : 0;
  const expected_value_notional =
    total_intents > 0 ? Math.round((evNotionalSum / total_intents) * 100) / 100 : 0;
  const currencySet = [
    ...new Set(simulationIntents.map((intent) => intentCurrency(intent))),
  ].toSorted();
  const maxRiskNotional = simulationIntents.reduce(
    (max, intent) => Math.max(max, intentRiskNotional(intent)),
    0,
  );

  const stats = {
    total_intents,
    filled_count,
    fill_rate,
    total_pnl_pts,
    total_pnl_notional,
    avg_pnl_pts,
    avg_pnl_notional,
    win_rate,
    evidence_fill_rate: evidenceFillRate,
    evidence_win_rate: evidenceWinRate,
    evidence_sample_count: Number(monteCarlo.fill_attempt_count ?? 0),
    sharpe_proxy,
    win_streak_max,
    loss_streak_max,
    expected_value_pts,
    expected_value_notional,
    by_strategy: Object.fromEntries(
      Object.entries(byStrategy).map(([k, v]) => [
        k,
        {
          count: v.count,
          filled: v.filled,
          wins: v.wins,
          win_rate: v.filled > 0 ? Math.round((v.wins / v.filled) * 1000) / 1000 : 0,
          pnl_pts: roundNumber(v.pnlPts, pnlPointDecimals),
          pnl_notional: roundNumber(v.pnlNotional),
        },
      ]),
    ),
    invalid_intent_count: invalidIntentCount,
    normalized_legacy_alias_count: 0,
    blocked_legacy_alias_count: blockedLegacyAliasCount,
    historical_snapshot_count: historicalSnapshotCount,
    route_unresolved_count: routeUnresolvedCount,
    paper_exploration_only_count: paperExplorationOnlyCount,
    execution_ineligible_count: executionIneligibleCount,
    promotion_blocked_intent_count: promotionBlockedIntentCount,
    source_intent_count: parsedIntents.length,
    risk_approved_intent_count: simulationIntents.length,
    risk_filtered_intent_count: Math.max(0, parsedIntents.length - simulationIntents.length),
    downside_filtered_intent_count: Number(riskBatch.filter?.downsideFilteredIntentCount ?? 0),
    max_risk_notional: roundNumber(maxRiskNotional),
    currency_set: currencySet,
    source_historical_snapshot_count: sourceHistoricalSnapshotCount,
    source_route_unresolved_count: sourceRouteUnresolvedCount,
    source_paper_exploration_only_count: sourcePaperExplorationOnlyCount,
    source_execution_ineligible_count: sourceExecutionIneligibleCount,
    source_promotion_blocked_intent_count: sourcePromotionBlockedIntentCount,
    risk_filter: riskBatch.filter,
  };
  const generatedCurrentFallback =
    source.sourceKind === "generated_current" ||
    String(source.fallbackReason ?? "").includes("generated_current");
  const currentIntentSourceUsable = !source.fallbackUsed || generatedCurrentFallback;
  const currentPaperIntentsReady =
    currentIntentSourceUsable &&
    total_intents > 0 &&
    historicalSnapshotCount === 0 &&
    routeUnresolvedCount === 0 &&
    paperExplorationOnlyCount === 0 &&
    executionIneligibleCount === 0 &&
    promotionBlockedIntentCount === 0 &&
    sourceHistoricalSnapshotCount === 0 &&
    sourceRouteUnresolvedCount === 0 &&
    sourcePaperExplorationOnlyCount === 0 &&
    sourceExecutionIneligibleCount === 0 &&
    sourcePromotionBlockedIntentCount === 0;
  const historicalSimulation = !currentIntentSourceUsable || historicalSnapshotCount > 0;
  const currentPaperBlocked = !currentPaperIntentsReady && !historicalSimulation;
  const status = currentPaperIntentsReady
    ? "ok"
    : currentPaperBlocked
      ? "current_paper_blocked"
      : "historical_simulated";

  // 評估：必須是當輪 primary intents，且尾端風險(p05)為正，才允許 paper promotion。
  const recommendation =
    currentPaperIntentsReady &&
    expected_value_pts > 0 &&
    evidenceFillRate >= 0.5 &&
    evidenceWinRate >= 0.48 &&
    monteCarlo.p05_total_pnl_pts > 0
      ? "promote"
      : "hold";
  const promotionGate = buildPromotionGate({
    currentPaperIntentsReady,
    source,
    stats,
    monteCarlo,
    recommendation,
  });
  const tailRiskRepair = buildTailRiskRepair({
    stats,
    monteCarlo,
    promotionGate,
    empiricalTailEvidence,
  });

  const report = {
    schema: SCHEMA,
    generatedAt,
    status,
    recommendation,
    source: {
      intentsPath: source.path,
      primaryIntentsPath: intentsPath,
      generatedCurrentIntentsPath,
      fallbackIntentsPath,
      fallbackUsed: source.fallbackUsed,
      sourceKind: source.sourceKind ?? "",
      fallbackReason: source.fallbackReason ?? "",
      simulationMode: historicalSimulation
        ? "historical_snapshot"
        : currentPaperBlocked
          ? "current_paper_blocked"
          : "current_paper_intents",
    },
    stats,
    monteCarlo,
    promotionGate,
    empiricalTailEvidence,
    tailRiskRepair,
    fillModel: {
      model: "deterministic_probabilistic_fill_v1",
      monteCarloIterations,
      slippage: "risk_scaled_deterministic",
      contractPointValueModel: "openclaw_static_contract_point_value_proxy_v1",
      notionalAggregationWarning:
        currencySet.length > 1 ? "mixed_currency_notional_proxy_not_fx_converted" : "",
      historicalSnapshotNotExecutionEligible: historicalSimulation,
      currentPaperBlockedNotExecutionEligible: currentPaperBlocked,
    },
    safetyLock: baseSafetyLock({
      executionEligible: currentPaperIntentsReady,
      promotionBlocked: recommendation !== "promote",
      historicalSnapshot: historicalSimulation,
    }),
  };

  await writeJsonWithSha(outputPath, report);
  return report;
}

// ─── CLI ──────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  function flag(name) {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  const result = await runStrategyFillSimulation({
    repoRoot: flag("--repo-root"),
    intentsPath: flag("--intents-path"),
    outputPath: flag("--output-path"),
    fallbackIntentsPath: flag("--fallback-intents-path"),
    monteCarloIterations: flag("--monte-carlo-iterations"),
  });

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const s = result.stats;
    process.stdout.write(
      [
        `schema:              ${result.schema}`,
        `status:              ${result.status}`,
        `recommendation:      ${result.recommendation}`,
        `total_intents:       ${s.total_intents}`,
        `filled_count:        ${s.filled_count}  (fill_rate=${s.fill_rate})`,
        `win_rate:            ${s.win_rate}`,
        `total_pnl_pts:       ${s.total_pnl_pts}`,
        `total_pnl_notional:  ${s.total_pnl_notional}`,
        `avg_pnl_pts:         ${s.avg_pnl_pts}`,
        `avg_pnl_notional:    ${s.avg_pnl_notional}`,
        `expected_value_pts:  ${s.expected_value_pts}`,
        `expected_value_notional: ${s.expected_value_notional}`,
        `sharpe_proxy:        ${s.sharpe_proxy}`,
        `monte_carlo:         ${result.monteCarlo?.iterations ?? 0} iterations p05=${result.monteCarlo?.p05_total_pnl_pts ?? 0} p50=${result.monteCarlo?.p50_total_pnl_pts ?? 0} p95=${result.monteCarlo?.p95_total_pnl_pts ?? 0} notional_p05=${result.monteCarlo?.p05_total_pnl_notional ?? 0}`,
        `source:              ${result.source?.fallbackUsed ? "fallback" : "primary"} ${result.source?.intentsPath ?? ""}`,
        `win_streak_max:      ${s.win_streak_max}`,
        `loss_streak_max:     ${s.loss_streak_max}`,
        `by_strategy:         ${JSON.stringify(s.by_strategy)}`,
      ].join("\n") + "\n",
    );
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
