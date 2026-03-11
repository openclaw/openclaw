import { pearsonCorrelation } from "../fund/correlation-monitor.js";
import { computeSharpe } from "./monte-carlo-test.js";
import type { IndependenceResult } from "./types.js";

export class AlphaIndependenceChecker {
  check(candidateReturns: number[], existingCurves: Map<string, number[]>): IndependenceResult {
    let maxCorrelation = 0;
    let mostCorrelatedWith: string | undefined;

    for (const [name, curve] of existingCurves) {
      const corr = Math.abs(pearsonCorrelation(candidateReturns, curve));
      if (corr > maxCorrelation) {
        maxCorrelation = corr;
        mostCorrelatedWith = name;
      }
    }

    // Use candidate's own Sharpe as marginal contribution proxy
    const marginalSharpe = computeSharpe(candidateReturns);

    return {
      maxCorrelation,
      mostCorrelatedWith,
      marginalSharpe,
      passed: maxCorrelation < 0.5 && marginalSharpe > 0.05,
    };
  }
}
