/**
 * Statistical helpers shared across lanes.
 */

export type SummaryStats = {
  avg: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
};

export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : (sorted[mid] ?? 0);
}

export function summarize(values: number[]): SummaryStats {
  if (values.length === 0) {
    return { avg: 0, p50: 0, p95: 0, min: 0, max: 0 };
  }
  const total = values.reduce((s, v) => s + v, 0);
  return {
    avg: total / values.length,
    p50: median(values),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

export function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}
