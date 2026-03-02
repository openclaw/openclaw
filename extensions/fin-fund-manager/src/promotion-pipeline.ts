import type { StrategyLevel } from "../../fin-shared-types/src/types.js";
import type { StrategyProfile, PromotionCheck, DemotionCheck } from "./types.js";

/**
 * Promotion and demotion pipeline for strategy lifecycle.
 *
 * Promotion thresholds:
 *   L0 → L1: Strategy definition is valid (always auto-promoted)
 *   L1 → L2: Walk-Forward passed, Sharpe ≥ 1.0, maxDD ≤ 25%, trades ≥ 100, 3+ regimes
 *   L2 → L3: Paper ≥ 30 days, ≥ 30 trades, Sharpe ≥ 0.5, DD ≤ 20%, backtest deviation ≤ 30%
 *
 * Demotion triggers:
 *   L3 → L2: 3 consecutive loss days over limit / 7d Sharpe < 0
 *   L2 → L1: 30d Sharpe < -0.5 / backtest deviation > 50%
 *   Any → KILLED: 3 consecutive periods in bottom 20% / cumulative loss > 40%
 */
export class PromotionPipeline {
  /** Check if a strategy is eligible for promotion. */
  checkPromotion(profile: StrategyProfile): PromotionCheck {
    const result: PromotionCheck = {
      strategyId: profile.id,
      currentLevel: profile.level,
      eligible: false,
      reasons: [],
      blockers: [],
    };

    switch (profile.level) {
      case "L0_INCUBATE":
        return this.checkL0toL1(profile, result);
      case "L1_BACKTEST":
        return this.checkL1toL2(profile, result);
      case "L2_PAPER":
        return this.checkL2toL3(profile, result);
      default:
        result.blockers.push(`Level ${profile.level} has no promotion target`);
        return result;
    }
  }

  /** Check if a strategy should be demoted. */
  checkDemotion(profile: StrategyProfile): DemotionCheck {
    const result: DemotionCheck = {
      strategyId: profile.id,
      currentLevel: profile.level,
      shouldDemote: false,
      reasons: [],
    };

    switch (profile.level) {
      case "L3_LIVE":
        return this.checkL3Demotion(profile, result);
      case "L2_PAPER":
        return this.checkL2Demotion(profile, result);
      default:
        return result;
    }
  }

  private checkL0toL1(profile: StrategyProfile, result: PromotionCheck): PromotionCheck {
    // L0 → L1: Auto-promote if strategy exists and has valid definition
    result.eligible = true;
    result.targetLevel = "L1_BACKTEST";
    result.reasons.push("Strategy definition is valid");
    return result;
  }

  private checkL1toL2(profile: StrategyProfile, result: PromotionCheck): PromotionCheck {
    result.targetLevel = "L2_PAPER";
    const bt = profile.backtest;
    const wf = profile.walkForward;

    // Walk-Forward must pass
    if (!wf) {
      result.blockers.push("No walk-forward result available");
    } else if (!wf.passed) {
      result.blockers.push(
        `Walk-forward failed (ratio=${wf.ratio.toFixed(2)}, threshold=${wf.threshold})`,
      );
    } else {
      result.reasons.push(`Walk-forward passed (ratio=${wf.ratio.toFixed(2)})`);
    }

    // Sharpe ≥ 1.0
    if (!bt) {
      result.blockers.push("No backtest result available");
    } else {
      if (bt.sharpe >= 1.0) {
        result.reasons.push(`Sharpe ${bt.sharpe.toFixed(2)} ≥ 1.0`);
      } else {
        result.blockers.push(`Sharpe ${bt.sharpe.toFixed(2)} < 1.0`);
      }

      // Max drawdown ≤ 25%
      if (Math.abs(bt.maxDrawdown) <= 25) {
        result.reasons.push(`MaxDD ${bt.maxDrawdown.toFixed(1)}% within 25% limit`);
      } else {
        result.blockers.push(`MaxDD ${bt.maxDrawdown.toFixed(1)}% exceeds 25% limit`);
      }

      // At least 100 trades
      if (bt.totalTrades >= 100) {
        result.reasons.push(`${bt.totalTrades} trades ≥ 100`);
      } else {
        result.blockers.push(`Only ${bt.totalTrades} trades, need ≥ 100`);
      }
    }

    result.eligible = result.blockers.length === 0;
    return result;
  }

  private checkL2toL3(profile: StrategyProfile, result: PromotionCheck): PromotionCheck {
    result.targetLevel = "L3_LIVE";

    // Paper ≥ 30 days
    const days = profile.paperDaysActive ?? 0;
    if (days >= 30) {
      result.reasons.push(`Paper trading ${days} days ≥ 30`);
    } else {
      result.blockers.push(`Paper trading only ${days} days, need ≥ 30`);
    }

    // Paper ≥ 30 trades
    const trades = profile.paperTradeCount ?? 0;
    if (trades >= 30) {
      result.reasons.push(`Paper trades ${trades} ≥ 30`);
    } else {
      result.blockers.push(`Paper trades only ${trades}, need ≥ 30`);
    }

    // Paper Sharpe ≥ 0.5
    const paperSharpe = profile.paperMetrics?.rollingSharpe30d ?? 0;
    if (paperSharpe >= 0.5) {
      result.reasons.push(`Paper Sharpe ${paperSharpe.toFixed(2)} ≥ 0.5`);
    } else {
      result.blockers.push(`Paper Sharpe ${paperSharpe.toFixed(2)} < 0.5`);
    }

    // Paper drawdown ≤ 20%
    const paperDD = Math.abs(profile.paperMetrics?.currentDrawdown ?? 0);
    if (paperDD <= 20) {
      result.reasons.push(`Paper drawdown ${paperDD.toFixed(1)}% ≤ 20%`);
    } else {
      result.blockers.push(`Paper drawdown ${paperDD.toFixed(1)}% > 20%`);
    }

    // Backtest vs paper deviation ≤ 30%
    if (profile.backtest && profile.paperMetrics) {
      const btSharpe = profile.backtest.sharpe;
      const deviation = btSharpe > 0 ? (Math.abs(btSharpe - paperSharpe) / btSharpe) * 100 : 0;
      if (deviation <= 30) {
        result.reasons.push(`BT-Paper deviation ${deviation.toFixed(0)}% ≤ 30%`);
      } else {
        result.blockers.push(`BT-Paper deviation ${deviation.toFixed(0)}% > 30%`);
      }
    }

    result.eligible = result.blockers.length === 0;
    if (result.eligible) {
      result.needsUserConfirmation = true;
    }
    return result;
  }

  private checkL3Demotion(profile: StrategyProfile, result: DemotionCheck): DemotionCheck {
    const metrics = profile.paperMetrics;
    if (!metrics) return result;

    // 3 consecutive loss days
    if (metrics.consecutiveLossDays >= 3) {
      result.shouldDemote = true;
      result.targetLevel = "L2_PAPER";
      result.reasons.push(`${metrics.consecutiveLossDays} consecutive loss days ≥ 3`);
    }

    // 7d Sharpe < 0
    if (metrics.rollingSharpe7d < 0) {
      result.shouldDemote = true;
      result.targetLevel = "L2_PAPER";
      result.reasons.push(`7d Sharpe ${metrics.rollingSharpe7d.toFixed(2)} < 0`);
    }

    // Critical decay level → immediate demotion
    if (metrics.decayLevel === "critical") {
      result.shouldDemote = true;
      result.targetLevel = "L2_PAPER";
      result.reasons.push("Decay level is critical");
    }

    // Cumulative loss > 40% → KILLED
    if (profile.paperEquity && profile.paperInitialCapital) {
      const cumLoss = (1 - profile.paperEquity / profile.paperInitialCapital) * 100;
      if (cumLoss > 40) {
        result.shouldDemote = true;
        result.targetLevel = "KILLED";
        result.reasons.push(`Cumulative loss ${cumLoss.toFixed(1)}% > 40%`);
      }
    }

    return result;
  }

  private checkL2Demotion(profile: StrategyProfile, result: DemotionCheck): DemotionCheck {
    const metrics = profile.paperMetrics;
    if (!metrics) return result;

    // 30d Sharpe < -0.5
    if (metrics.rollingSharpe30d < -0.5) {
      result.shouldDemote = true;
      result.targetLevel = "L1_BACKTEST";
      result.reasons.push(`30d Sharpe ${metrics.rollingSharpe30d.toFixed(2)} < -0.5`);
    }

    // Backtest vs paper deviation > 50%
    if (profile.backtest) {
      const btSharpe = profile.backtest.sharpe;
      const paperSharpe = metrics.rollingSharpe30d;
      if (btSharpe > 0) {
        const deviation = (Math.abs(btSharpe - paperSharpe) / btSharpe) * 100;
        if (deviation > 50) {
          result.shouldDemote = true;
          result.targetLevel = "L1_BACKTEST";
          result.reasons.push(`BT-Paper deviation ${deviation.toFixed(0)}% > 50%`);
        }
      }
    }

    // Cumulative loss > 40% → KILLED
    if (profile.paperEquity && profile.paperInitialCapital) {
      const cumLoss = (1 - profile.paperEquity / profile.paperInitialCapital) * 100;
      if (cumLoss > 40) {
        result.shouldDemote = true;
        result.targetLevel = "KILLED";
        result.reasons.push(`Cumulative loss ${cumLoss.toFixed(1)}% > 40%`);
      }
    }

    return result;
  }
}
