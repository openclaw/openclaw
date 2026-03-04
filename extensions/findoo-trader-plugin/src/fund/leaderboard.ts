import type { StrategyLevel } from "../shared/types.js";
import type { StrategyProfile, LeaderboardEntry } from "./types.js";

/**
 * Strategy leaderboard with confidence-adjusted scoring.
 *
 * Confidence multipliers:
 *   Backtest only (L1):          × 0.3
 *   Backtest + Paper (L2):       × 0.7
 *   Backtest + Paper + Live (L3): × 1.0
 *   Walk-forward verified:        + 0.1 bonus
 */
export class Leaderboard {
  /** Build ranked leaderboard from strategy profiles. */
  rank(strategies: StrategyProfile[]): LeaderboardEntry[] {
    const scored = strategies
      .filter((s) => s.level !== "KILLED" && s.level !== "L0_INCUBATE")
      .map((s) => {
        const multiplier = getConfidenceMultiplier(s);
        const score = s.fitness * multiplier;

        return {
          rank: 0, // will be filled after sort
          strategyId: s.id,
          strategyName: s.name,
          level: s.level,
          fitness: Math.round(s.fitness * 1000) / 1000,
          confidenceMultiplier: multiplier,
          leaderboardScore: Math.round(score * 1000) / 1000,
          sharpe: s.backtest?.sharpe ?? 0,
          maxDrawdown: s.backtest?.maxDrawdown ?? 0,
          totalTrades: s.backtest?.totalTrades ?? 0,
        };
      })
      .sort((a, b) => b.leaderboardScore - a.leaderboardScore);

    // Assign ranks (1-indexed)
    for (let i = 0; i < scored.length; i++) {
      scored[i]!.rank = i + 1;
    }

    return scored;
  }
}

function getConfidenceMultiplier(s: StrategyProfile): number {
  let base: number;
  switch (s.level) {
    case "L1_BACKTEST":
      base = 0.3;
      break;
    case "L2_PAPER":
      base = 0.7;
      break;
    case "L3_LIVE":
      base = 1.0;
      break;
    default:
      base = 0.1;
  }

  // Walk-forward verification bonus
  if (s.walkForward?.passed) base += 0.1;

  return Math.round(base * 10) / 10;
}
