/**
 * metrics.ts — ClaWorks 轻量级指标收集器
 *
 * 提供计数器、延迟直方图、运行时摘要。
 * 无外部依赖，单例生命周期与进程绑定。
 *
 * 使用：
 *   import { globalMetrics } from "./metrics.js";
 *   globalMetrics.increment("playbook.run", { playbook_id: "my_pb" });
 *   globalMetrics.recordDuration("capability.latency_ms", 42, { id: "kb.search" });
 */

export type HistogramStats = {
  count: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
};

export type MetricsSnapshot = {
  uptime_ms: number;
  counters: Record<string, number>;
  histograms: Record<string, HistogramStats>;
  captured_at: string;
};

export class MetricsCollector {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();
  private readonly startTime = Date.now();
  /** Maximum samples retained per histogram key */
  private readonly maxSamples: number;

  constructor(maxSamples = 1000) {
    this.maxSamples = maxSamples;
  }

  // ── Counters ──────────────────────────────────────────────────────────

  increment(name: string, labels?: Record<string, string>): void {
    const key = makeKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  incrementBy(name: string, amount: number, labels?: Record<string, string>): void {
    const key = makeKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  getCounter(name: string, labels?: Record<string, string>): number {
    return this.counters.get(makeKey(name, labels)) ?? 0;
  }

  // ── Histograms ────────────────────────────────────────────────────────

  recordDuration(name: string, durationMs: number, labels?: Record<string, string>): void {
    const key = makeKey(name, labels);
    let hist = this.histograms.get(key);
    if (!hist) {
      hist = [];
      this.histograms.set(key, hist);
    }
    hist.push(durationMs);
    // Evict oldest when over limit (O(1) amortized with shift)
    if (hist.length > this.maxSamples) {
      hist.shift();
    }
  }

  getHistogramStats(name: string, labels?: Record<string, string>): HistogramStats | undefined {
    const values = this.histograms.get(makeKey(name, labels));
    if (!values || values.length === 0) {
      return undefined;
    }
    return computeStats(values);
  }

  // ── Snapshot ──────────────────────────────────────────────────────────

  snapshot(): MetricsSnapshot {
    const histSnap: Record<string, HistogramStats> = {};
    for (const [key, values] of this.histograms) {
      if (values.length > 0) {
        histSnap[key] = computeStats(values);
      }
    }

    return {
      uptime_ms: Date.now() - this.startTime,
      counters: Object.fromEntries(this.counters),
      histograms: histSnap,
      captured_at: new Date().toISOString(),
    };
  }

  /** Reset all metrics (useful for tests) */
  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makeKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) {
    return name;
  }
  const labelStr = Object.entries(labels)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
  return `${name}{${labelStr}}`;
}

function computeStats(values: number[]): HistogramStats {
  const sorted = [...values].toSorted((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const percentile = (p: number): number => sorted[Math.floor(sorted.length * p)] ?? 0;

  return {
    count: sorted.length,
    avg: sorted.length > 0 ? Math.round(sum / sorted.length) : 0,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}

// ── Global singleton ──────────────────────────────────────────────────────

/** Process-level metrics collector. Import and use directly in hot paths. */
export const globalMetrics = new MetricsCollector();
