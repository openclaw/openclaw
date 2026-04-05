import type { PerfMetricsSnapshot } from "./runtime-types.js";

type TimingBucket = {
  count: number;
  totalMs: number;
  maxMs: number;
};

const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const timings = new Map<string, TimingBucket>();

function hrNow(): bigint {
  return process.hrtime.bigint();
}

function durationMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(3));
}

export function incrementPerfCounter(name: string, delta = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + delta);
}

export function setPerfGauge(name: string, value: number): void {
  gauges.set(name, value);
}

export function recordPerfDuration(name: string, durationMsValue: number): void {
  const next = timings.get(name) ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
  };
  next.count += 1;
  next.totalMs += durationMsValue;
  next.maxMs = Math.max(next.maxMs, durationMsValue);
  timings.set(name, next);
}

export async function measurePerf<T>(name: string, run: () => Promise<T>): Promise<T> {
  const startedAt = hrNow();
  try {
    return await run();
  } finally {
    recordPerfDuration(name, durationMs(startedAt));
  }
}

export function startPerfTimer(name: string): () => number {
  const startedAt = hrNow();
  return () => {
    const elapsedMs = durationMs(startedAt);
    recordPerfDuration(name, elapsedMs);
    return elapsedMs;
  };
}

export function getPerfMetricsSnapshot(): PerfMetricsSnapshot {
  return {
    counters: Object.fromEntries(counters.entries()),
    gauges: Object.fromEntries(gauges.entries()),
    timings: Object.fromEntries(
      [...timings.entries()].map(([name, bucket]) => [
        name,
        {
          count: bucket.count,
          totalMs: roundMetric(bucket.totalMs),
          maxMs: roundMetric(bucket.maxMs),
        },
      ]),
    ),
  };
}

export function resetPerfMetrics(): void {
  counters.clear();
  gauges.clear();
  timings.clear();
}

export function formatPerfMetric(name: string, durationMsValue: number): string {
  return `${name}=${roundMetric(durationMsValue)}ms`;
}
