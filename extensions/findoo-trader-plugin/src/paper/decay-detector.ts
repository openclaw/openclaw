import { sharpeRatio } from "../shared/stats.js";
import type { DecayState, EquitySnapshot } from "./types.js";

const MIN_DAYS = 7;

export class DecayDetector {
  /** Evaluate strategy health from equity snapshots. */
  evaluate(snapshots: EquitySnapshot[]): DecayState {
    if (snapshots.length < MIN_DAYS) {
      return {
        rollingSharpe7d: 0,
        rollingSharpe30d: 0,
        sharpeMomentum: 1,
        consecutiveLossDays: 0,
        currentDrawdown: 0,
        peakEquity: snapshots.length > 0 ? snapshots[snapshots.length - 1]!.equity : 0,
        decayLevel: "healthy",
      };
    }

    // Compute daily returns from equity curve
    const dailyReturns: number[] = [];
    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1]!.equity;
      const curr = snapshots[i]!.equity;
      dailyReturns.push(prev > 0 ? (curr - prev) / prev : 0);
    }

    // Rolling Sharpe over last 7 and 30 days
    const returns7d = dailyReturns.slice(-7);
    const returns30d = dailyReturns.slice(-30);

    const sharpe7d = returns7d.length >= 2 ? sharpeRatio(returns7d, 0, true) : 0;
    const sharpe30d = returns30d.length >= 2 ? sharpeRatio(returns30d, 0, true) : 0;

    // Sharpe momentum: if 30d sharpe is near zero, use 7d sign as indicator
    let sharpeMomentum: number;
    if (Math.abs(sharpe30d) < 0.001) {
      sharpeMomentum = sharpe7d >= 0 ? 1 : -1;
    } else {
      sharpeMomentum = sharpe7d / sharpe30d;
    }

    // Handle non-finite values from the sharpe calculation
    if (!Number.isFinite(sharpeMomentum)) {
      sharpeMomentum = sharpe7d >= 0 ? 1 : -1;
    }

    // Consecutive loss days (counting from the end)
    let consecutiveLossDays = 0;
    for (let i = dailyReturns.length - 1; i >= 0; i--) {
      if (dailyReturns[i]! < 0) {
        consecutiveLossDays++;
      } else {
        break;
      }
    }

    // Current drawdown from peak
    let peakEquity = 0;
    for (const snap of snapshots) {
      if (snap.equity > peakEquity) peakEquity = snap.equity;
    }
    const currentEquity = snapshots[snapshots.length - 1]!.equity;
    const currentDrawdown = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;

    // Determine decay level
    const decayLevel = classifyDecay(sharpeMomentum, consecutiveLossDays, currentDrawdown);

    return {
      rollingSharpe7d: sharpe7d,
      rollingSharpe30d: sharpe30d,
      sharpeMomentum,
      consecutiveLossDays,
      currentDrawdown,
      peakEquity,
      decayLevel,
    };
  }
}

function classifyDecay(
  sharpeMomentum: number,
  consecutiveLossDays: number,
  drawdownPct: number,
): DecayState["decayLevel"] {
  // Critical: worst conditions (checked first)
  if (sharpeMomentum < -0.5 || consecutiveLossDays >= 7 || drawdownPct > 25) {
    return "critical";
  }
  // Degrading
  if (sharpeMomentum < 0 || consecutiveLossDays >= 5 || drawdownPct > 15) {
    return "degrading";
  }
  // Warning
  if (sharpeMomentum < 0.5 || consecutiveLossDays >= 3) {
    return "warning";
  }
  // Healthy
  return "healthy";
}
