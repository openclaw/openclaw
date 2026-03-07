/**
 * Pure statistical functions for strategy performance analysis.
 * Zero external dependencies.
 *
 * mean, stdDev, and sharpeRatio are canonical in @openfinclaw/fin-shared-types
 * and re-exported here for backward compatibility within fin-strategy-engine.
 */

export { mean, stdDev, sharpeRatio } from "../shared/stats.js";

import { mean } from "../shared/stats.js";

/**
 * Sortino Ratio: like Sharpe but penalizes only downside deviation.
 * Annualized by sqrt(252).
 */
export function sortinoRatio(returns: number[], riskFreeRate = 0): number {
  const excess = returns.map((r) => r - riskFreeRate);
  const m = mean(excess);

  // Downside deviation: stddev of negative excess returns only
  const downsideSquares = excess.filter((r) => r < 0).map((r) => r * r);
  if (downsideSquares.length === 0) {
    return m >= 0 ? Infinity : -Infinity;
  }

  let sumSq = 0;
  for (const sq of downsideSquares) sumSq += sq;
  const downsideDev = Math.sqrt(sumSq / returns.length);

  if (downsideDev === 0) {
    return m >= 0 ? Infinity : -Infinity;
  }

  return (m / downsideDev) * Math.sqrt(252);
}

/**
 * Maximum drawdown from an equity curve.
 * Returns the worst peak-to-trough decline as a percentage.
 */
export function maxDrawdown(equityCurve: number[]): {
  maxDD: number;
  peak: number;
  trough: number;
  peakIndex: number;
  troughIndex: number;
} {
  if (equityCurve.length <= 1) {
    return {
      maxDD: 0,
      peak: equityCurve[0] ?? 0,
      trough: equityCurve[0] ?? 0,
      peakIndex: 0,
      troughIndex: 0,
    };
  }

  let peak = equityCurve[0];
  let peakIdx = 0;
  let worstDD = 0;
  let worstPeak = peak;
  let worstTrough = peak;
  let worstPeakIdx = 0;
  let worstTroughIdx = 0;

  for (let i = 1; i < equityCurve.length; i++) {
    const val = equityCurve[i];
    if (val > peak) {
      peak = val;
      peakIdx = i;
    }
    const dd = ((val - peak) / peak) * 100;
    if (dd < worstDD) {
      worstDD = dd;
      worstPeak = peak;
      worstTrough = val;
      worstPeakIdx = peakIdx;
      worstTroughIdx = i;
    }
  }

  return {
    maxDD: worstDD,
    peak: worstPeak,
    trough: worstTrough,
    peakIndex: worstPeakIdx,
    troughIndex: worstTroughIdx,
  };
}

/** Calmar Ratio: annualized return / |maxDrawdown|. */
export function calmarRatio(annualizedReturn: number, maxDD: number): number {
  if (maxDD === 0) return annualizedReturn >= 0 ? Infinity : -Infinity;
  return annualizedReturn / Math.abs(maxDD);
}

/**
 * Profit Factor: sum(wins) / sum(|losses|).
 * Wins are positive values, losses are negative or passed as-is (abs taken).
 */
export function profitFactor(wins: number[], losses: number[]): number {
  const totalWins = wins.reduce((s, v) => s + v, 0);
  const totalLosses = losses.reduce((s, v) => s + Math.abs(v), 0);
  if (totalLosses === 0) return totalWins > 0 ? Infinity : 0;
  if (totalWins === 0) return 0;
  return totalWins / totalLosses;
}

/** Win rate as a percentage (0-100). Wins = trades with pnl > 0. */
export function winRate(trades: Array<{ pnl: number }>): number {
  if (trades.length === 0) return NaN;
  const wins = trades.filter((t) => t.pnl > 0).length;
  return (wins / trades.length) * 100;
}
