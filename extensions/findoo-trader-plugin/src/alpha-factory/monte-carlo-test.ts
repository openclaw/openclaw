import type { MonteCarloResult } from "./types.js";

/** Compute annualized Sharpe ratio from daily returns. */
export function computeSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(252);
}

/** Fisher-Yates in-place shuffle. */
function shuffle(arr: number[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Monte Carlo permutation test for Sharpe ratio significance.
 * Shuffles daily returns `trials` times and checks if original Sharpe
 * is statistically significant (p < 0.05).
 */
export function runMonteCarloTest(dailyReturns: number[], trials = 1000): MonteCarloResult {
  const originalSharpe = computeSharpe(dailyReturns);
  const permuted = [...dailyReturns];
  const permutedSharpes: number[] = [];
  let countAbove = 0;

  for (let t = 0; t < trials; t++) {
    shuffle(permuted);
    const s = computeSharpe(permuted);
    permutedSharpes.push(s);
    if (s >= originalSharpe) countAbove++;
  }

  permutedSharpes.sort((a, b) => a - b);
  const permutedMean = permutedSharpes.reduce((s, v) => s + v, 0) / trials;
  const p95Index = Math.floor(trials * 0.95);
  const permutedP95 = permutedSharpes[p95Index] ?? permutedSharpes[permutedSharpes.length - 1];
  const pValue = countAbove / trials;

  return {
    pValue,
    trials,
    originalSharpe,
    permutedMean,
    permutedP95,
    passed: pValue < 0.05,
  };
}
