import type { BacktestResult, MarketRegime } from "../shared/types.js";
import { AlphaIndependenceChecker } from "./alpha-independence.js";
import { analyzeCostSensitivity } from "./cost-sensitivity.js";
import { runMonteCarloTest } from "./monte-carlo-test.js";
import { RegimeSplitValidator } from "./regime-split-validator.js";
import type { ValidationResult } from "./types.js";

/**
 * Fail-fast validation pipeline.
 * Runs Monte Carlo → Regime Split → Cost Sensitivity → Independence.
 * Returns early on first failure.
 */
export class ValidationOrchestrator {
  private regimeValidator = new RegimeSplitValidator();
  private independenceChecker = new AlphaIndependenceChecker();

  async validate(
    backtestResult: BacktestResult,
    regimeLabels: MarketRegime[],
    existingCurves: Map<string, number[]>,
  ): Promise<ValidationResult> {
    const { strategyId, dailyReturns, trades } = backtestResult;

    // Step 1: Monte Carlo
    const monteCarlo = runMonteCarloTest(dailyReturns);
    if (!monteCarlo.passed) {
      return { strategyId, passed: false, monteCarlo, failedAt: "monteCarlo" };
    }

    // Step 2: Regime Split
    const regimeSplit = await this.regimeValidator.validate(dailyReturns, regimeLabels);
    if (!regimeSplit.passed) {
      return { strategyId, passed: false, monteCarlo, regimeSplit, failedAt: "regimeSplit" };
    }

    // Step 3: Cost Sensitivity
    const baseCommission =
      trades.length > 0 ? trades.reduce((s, t) => s + t.commission, 0) / trades.length : 0;
    const costSensitivity = analyzeCostSensitivity(trades, dailyReturns, baseCommission);
    if (!costSensitivity.passed) {
      return {
        strategyId,
        passed: false,
        monteCarlo,
        regimeSplit,
        costSensitivity,
        failedAt: "costSensitivity",
      };
    }

    // Step 4: Alpha Independence
    const independence = this.independenceChecker.check(dailyReturns, existingCurves);
    if (!independence.passed) {
      return {
        strategyId,
        passed: false,
        monteCarlo,
        regimeSplit,
        costSensitivity,
        independence,
        failedAt: "independence",
      };
    }

    return {
      strategyId,
      passed: true,
      monteCarlo,
      regimeSplit,
      costSensitivity,
      independence,
    };
  }
}
