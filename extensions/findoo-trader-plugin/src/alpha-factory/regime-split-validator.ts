import type { MarketRegime } from "../shared/types.js";
import { computeSharpe } from "./monte-carlo-test.js";
import type { RegimeSplitResult } from "./types.js";

const MIN_RETURNS_PER_REGIME = 10;

export class RegimeSplitValidator {
  async validate(dailyReturns: number[], regimeLabels: MarketRegime[]): Promise<RegimeSplitResult> {
    // Group returns by regime label
    const groups = new Map<MarketRegime, number[]>();
    const len = Math.min(dailyReturns.length, regimeLabels.length);
    for (let i = 0; i < len; i++) {
      const regime = regimeLabels[i];
      let arr = groups.get(regime);
      if (!arr) {
        arr = [];
        groups.set(regime, arr);
      }
      arr.push(dailyReturns[i]);
    }

    const regimeResults: RegimeSplitResult["regimeResults"] = [];
    let passedRegimes = 0;

    for (const [regime, returns] of groups) {
      if (returns.length < MIN_RETURNS_PER_REGIME) continue;
      const sharpe = computeSharpe(returns);
      regimeResults.push({ regime, sharpe, trades: returns.length });
      if (sharpe > 0) passedRegimes++;
    }

    return {
      regimeResults,
      passedRegimes,
      totalRegimes: regimeResults.length,
      passed: passedRegimes >= 3,
    };
  }
}
