export function summarizeStreamingDistribution(values: number[]) {
  const xs = values.toSorted((a, b) => a - b);
  const quantile = (q: number) => {
    const at = (xs.length - 1) * q;
    const lo = Math.floor(at);
    return xs.length ? xs[lo]! + (xs[Math.ceil(at)]! - xs[lo]!) * (at - lo) : 0;
  };
  return {
    median: quantile(0.5),
    p95: quantile(0.95),
    iqr: quantile(0.75) - quantile(0.25),
    min: xs[0] ?? 0,
    max: xs.at(-1) ?? 0,
  };
}
