/**
 * Pure statistical functions shared across fin-* extensions.
 * Zero external dependencies.
 */

/** Arithmetic mean. Returns NaN for empty input. */
export function mean(data: number[]): number {
  if (data.length === 0) return NaN;
  let sum = 0;
  for (const v of data) sum += v;
  return sum / data.length;
}

/**
 * Standard deviation. Defaults to sample (Bessel-corrected).
 * Pass `population=true` for population stddev.
 */
export function stdDev(data: number[], population = false): number {
  const n = data.length;
  if (n === 0) return NaN;
  if (n === 1) return population ? 0 : NaN;

  const m = mean(data);
  let sumSq = 0;
  for (const v of data) {
    const d = v - m;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / (population ? n : n - 1));
}

/**
 * Sharpe Ratio.
 * @param returns Array of periodic returns (e.g. daily).
 * @param riskFreeRate Periodic risk-free rate (default 0).
 * @param annualize If true (default), multiply by sqrt(252).
 */
export function sharpeRatio(returns: number[], riskFreeRate = 0, annualize = true): number {
  const excess = returns.map((r) => r - riskFreeRate);
  const m = mean(excess);
  const sd = stdDev(excess);

  if (sd === 0 || Number.isNaN(sd)) {
    return m > 0 ? Infinity : m < 0 ? -Infinity : NaN;
  }

  const ratio = m / sd;
  return annualize ? ratio * Math.sqrt(252) : ratio;
}
