// Keep first-seen GC kinds and each kind's original summation order.
export function summarizeGcByKind(statistics: readonly { gcType: string; cost: number }[]) {
  return [...new Set(statistics.map((entry) => entry.gcType))].map((kind) => {
    const pauses = statistics
      .filter((entry) => entry.gcType === kind)
      .map((entry) => entry.cost / 1000);
    return {
      kind,
      count: pauses.length,
      totalMs: pauses.reduce((sum, ms) => sum + ms, 0),
      maxMs: Math.max(0, ...pauses),
    };
  });
}
