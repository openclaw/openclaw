import type { PerformanceEntry } from "node:perf_hooks";

// The observer callback and its final takeRecords drain use the same window.
export function recordGcCollections(
  entries: readonly PerformanceEntry[],
  collections: { kind: number; ms: number }[],
  start: number,
  end: number,
) {
  for (const entry of entries) {
    if (entry.startTime >= start && entry.startTime < end) {
      collections.push({
        kind: (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind,
        ms: entry.duration,
      });
    }
  }
}
