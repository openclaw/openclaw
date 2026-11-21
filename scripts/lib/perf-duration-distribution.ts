// Preserve nearest-rank percentiles and the empty-sample reporting shape.
export function summarizeDurationDistribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const count = sorted.length;
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count,
    totalMs,
    meanMs: count ? totalMs / count : 0,
    maxMs: sorted.at(-1) ?? 0,
    p95: { samples: count, ms: sorted[Math.ceil(count * 0.95) - 1] ?? null },
    p99: { samples: count, ms: sorted[Math.ceil(count * 0.99) - 1] ?? null },
  };
}
