/**
 * Garbage Collector: multi-rule strategy killer.
 *
 * Applies kill rules to identify strategies that should be retired.
 * Only checks L1_BACKTEST, L2_PAPER, L3_LIVE strategies.
 */

import type { StrategyProfile } from "../fund/types.js";
import type { DecayEstimate, GCResult } from "./types.js";

// Levels eligible for garbage collection
const GC_ELIGIBLE_LEVELS = new Set(["L1_BACKTEST", "L2_PAPER", "L3_LIVE"]);

export class GarbageCollector {
  collect(profiles: StrategyProfile[], decayEstimates?: Map<string, DecayEstimate>): GCResult {
    const killed: string[] = [];
    const reasons = new Map<string, string>();

    const eligible = profiles.filter((p) => GC_ELIGIBLE_LEVELS.has(p.level));

    for (const profile of eligible) {
      const killReason = this.checkKillRules(profile, decayEstimates);
      if (killReason) {
        killed.push(profile.id);
        reasons.set(profile.id, killReason);
      }
    }

    return { killed, reasons };
  }

  private checkKillRules(
    profile: StrategyProfile,
    decayEstimates?: Map<string, DecayEstimate>,
  ): string | null {
    const metrics = profile.paperMetrics;

    // Rule 1: Sustained negative rolling Sharpe (7d < -1)
    if (metrics && metrics.rollingSharpe7d < -1) {
      return `7d rolling Sharpe ${metrics.rollingSharpe7d.toFixed(2)} < -1 (sustained negative)`;
    }

    // Rule 2: 14 consecutive loss days with no recovery
    if (metrics && metrics.consecutiveLossDays >= 14) {
      return `${metrics.consecutiveLossDays} consecutive loss days >= 14 (no recovery)`;
    }

    // Rule 3: Inactive strategy (no trades after 14 days of paper trading)
    if (
      profile.paperTradeCount === 0 &&
      profile.paperDaysActive !== undefined &&
      profile.paperDaysActive >= 14
    ) {
      return `Zero trades after ${profile.paperDaysActive} days (inactive)`;
    }

    // Rule 4: Fast alpha decay (half-life < 15 days)
    const decay = decayEstimates?.get(profile.id);
    if (decay && decay.halfLifeDays < 15) {
      return `Alpha half-life ${decay.halfLifeDays.toFixed(1)} days < 15 (fast decay)`;
    }

    return null;
  }
}
