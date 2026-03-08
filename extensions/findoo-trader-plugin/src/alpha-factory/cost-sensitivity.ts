import type { TradeRecord } from "../shared/types.js";
import { computeSharpe } from "./monte-carlo-test.js";
import type { CostSensitivityResult } from "./types.js";

/**
 * Analyze how strategy performance degrades as transaction costs increase.
 * Tests at 1x, 2x, 3x of base commission. Passes if Sharpe > 0.5 at 3x.
 */
export function analyzeCostSensitivity(
  trades: TradeRecord[],
  dailyReturns: number[],
  baseCommission: number,
): CostSensitivityResult {
  const totalBaseCommission = trades.reduce((sum, t) => sum + t.commission, 0);
  const totalDays = dailyReturns.length;
  // Spread extra commission cost evenly across trading days
  const dailyBaseCost = totalBaseCommission / (totalDays || 1);

  const multipliers = [1, 2, 3];
  const results = multipliers.map((multiplier) => {
    // At multiplier=1, no adjustment (original). At 2x, subtract 1x extra cost per day, etc.
    const extraCostPerDay = dailyBaseCost * (multiplier - 1);
    const adjustedReturns = dailyReturns.map((r) => r - extraCostPerDay);
    const sharpe = computeSharpe(adjustedReturns);
    const netReturn = adjustedReturns.reduce((s, r) => s + r, 0);
    return { multiplier, sharpe, netReturn };
  });

  const sharpeAt3x = results.find((r) => r.multiplier === 3)?.sharpe ?? 0;

  return {
    results,
    sharpeAt3x,
    passed: sharpeAt3x > 0.5,
  };
}
