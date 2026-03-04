import type { CorrelationPair } from "./types.js";

/**
 * Computes pairwise Pearson correlation between strategy equity curves.
 * Used to detect overlapping strategies and enforce diversification constraints.
 */
export class CorrelationMonitor {
  /**
   * Compute pairwise correlations between strategies.
   *
   * @param curves - Map of strategyId → daily returns array
   * @returns Correlation matrix as nested maps + list of high-correlation pairs
   */
  compute(curves: Map<string, number[]>): {
    matrix: Map<string, Map<string, number>>;
    highCorrelation: CorrelationPair[];
  } {
    const ids = [...curves.keys()];
    const matrix = new Map<string, Map<string, number>>();
    const highCorrelation: CorrelationPair[] = [];

    for (const id of ids) {
      matrix.set(id, new Map());
    }

    for (let i = 0; i < ids.length; i++) {
      const idA = ids[i]!;
      const returnsA = curves.get(idA)!;
      matrix.get(idA)!.set(idA, 1);

      for (let j = i + 1; j < ids.length; j++) {
        const idB = ids[j]!;
        const returnsB = curves.get(idB)!;

        const corr = pearsonCorrelation(returnsA, returnsB);
        matrix.get(idA)!.set(idB, corr);
        matrix.get(idB)!.set(idA, corr);

        if (Math.abs(corr) >= 0.7) {
          highCorrelation.push({
            strategyA: idA,
            strategyB: idB,
            correlation: Math.round(corr * 1000) / 1000,
          });
        }
      }
    }

    return { matrix, highCorrelation };
  }
}

/**
 * Pearson correlation coefficient between two arrays.
 * Returns 0 if either array is too short or has zero variance.
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]!;
    sumY += y[i]!;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  if (varX === 0 || varY === 0) return 0;
  return cov / Math.sqrt(varX * varY);
}
