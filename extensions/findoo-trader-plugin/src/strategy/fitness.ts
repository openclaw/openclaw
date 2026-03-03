/**
 * Multi-window fitness function for strategy evaluation.
 * Combines long-term backtest, recent performance, and paper trading
 * with decay, overfit, correlation, and half-life penalties.
 */

// Canonical definition lives in @openfinclaw/fin-shared-types.
// Re-exported here for backward compatibility within fin-strategy-engine.
export type { FitnessInput } from "../shared/types.js";

import type { FitnessInput } from "../shared/types.js";

/** Score a single window: sharpe adjusted for drawdown depth. */
function windowScore(window: { sharpe: number; maxDD: number; trades: number }): number {
  // Sharpe is the primary signal; penalize deep drawdowns.
  // maxDD is negative (e.g. -0.1 for 10%), so abs is used.
  const ddPenalty = Math.abs(window.maxDD);
  return window.sharpe - ddPenalty;
}

/**
 * Calculate composite fitness score for a strategy.
 *
 * Weights:
 * - With paper data: paper 50% + recent 35% + longTerm 15%
 * - Without paper:   recent 70% + longTerm 30%
 *
 * Penalties:
 * - Decay:       max(0, longTerm.sharpe - recent.sharpe) * 0.30
 * - Overfit:     max(0, recent.sharpe - paper.sharpe)   * 0.50
 * - Correlation: correlationWithPortfolio * 0.20
 * - Half-life:   if days > 180, 0.1 * (days - 180) / 365
 */
export function calculateFitness(input: FitnessInput): number {
  const ltScore = windowScore(input.longTerm);
  const recentScore = windowScore(input.recent);

  let base: number;
  if (input.paper) {
    const paperScore = windowScore(input.paper);
    base = paperScore * 0.5 + recentScore * 0.35 + ltScore * 0.15;
  } else {
    base = recentScore * 0.7 + ltScore * 0.3;
  }

  // Decay penalty: strategy getting worse over time
  const decayPenalty = Math.max(0, input.longTerm.sharpe - input.recent.sharpe) * 0.3;

  // Overfit penalty: backtest looks great but paper trading is poor
  const paperSharpe = input.paper?.sharpe ?? input.recent.sharpe;
  const overfitPenalty = Math.max(0, input.recent.sharpe - paperSharpe) * 0.5;

  // Correlation penalty: strategy too correlated with existing portfolio
  const correlationPenalty = (input.correlationWithPortfolio ?? 0) * 0.2;

  // Half-life penalty: strategy may be stale
  const days = input.daysSinceLaunch ?? 0;
  const halfLifePenalty = days > 180 ? (0.1 * (days - 180)) / 365 : 0;

  return base - decayPenalty - overfitPenalty - correlationPenalty - halfLifePenalty;
}
