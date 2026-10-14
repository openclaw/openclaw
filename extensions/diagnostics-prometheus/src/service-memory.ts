import { asNonNegativeFiniteNumber as numericValue } from "openclaw/plugin-sdk/number-runtime";
import type { DiagnosticEventPayload } from "../api.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

export function recordMemorySample(
  store: PrometheusMetricStore,
  memory: Extract<DiagnosticEventPayload, { type: "diagnostic.memory.sample" }>["memory"],
  byteBuckets: number[],
): void {
  for (const worker of memory.workerLifecycle ?? []) {
    store.counterValue(
      "openclaw_worker_started_total",
      "Worker isolates created by bounded script basename.",
      { script: worker.script },
      worker.started,
    );
    for (const { reason, count } of worker.retired) {
      store.counterValue(
        "openclaw_worker_retired_total",
        "Worker isolates confirmed exited by owner retirement reason.",
        { script: worker.script, reason },
        count,
      );
    }
  }
  for (const [kind, field] of [
    ["rss", "rssBytes"],
    ["heap_total", "heapTotalBytes"],
    ["heap_used", "heapUsedBytes"],
    ["external", "externalBytes"],
    ["array_buffers", "arrayBuffersBytes"],
    ["worker_heap_total", "workerHeapTotalBytes"],
    ["worker_heap_used", "workerHeapUsedBytes"],
  ] as const) {
    store.gauge(
      "openclaw_memory_bytes",
      "Latest process memory usage by memory kind.",
      { kind },
      numericValue(memory[field]),
    );
  }
  for (const [name, field] of [
    ["openclaw_worker_count", "workerCount"],
    ["openclaw_worker_heap_sampled_count", "workerHeapSampledCount"],
  ] as const) {
    store.clearGauges(name);
    store.gauge(name, "Worker isolate counts.", {}, numericValue(memory[field]));
  }
  store.clearGauges("openclaw_heap_space_bytes");
  for (const space of memory.heapSpaces ?? []) {
    for (const [stat, field] of [
      ["used", "space_used_size"],
      ["size", "space_size"],
      ["available", "space_available_size"],
      ["physical", "physical_space_size"],
    ] as const) {
      store.gauge(
        "openclaw_heap_space_bytes",
        "Latest main-isolate V8 heap space usage in bytes.",
        { space: space.space_name, stat },
        space[field],
      );
    }
  }
  // The resource owner supplies bounded script names and retires stale/exit samples.
  const workers = new Map<
    string,
    { count: number; sampled: number; heapUsed: number | undefined }
  >();
  for (const worker of memory.workerHeaps ?? []) {
    const totals = workers.get(worker.script) ?? { count: 0, sampled: 0, heapUsed: undefined };
    totals.count++;
    totals.sampled++;
    const heapUsed = numericValue(worker.heapUsed);
    if (heapUsed !== undefined) {
      totals.heapUsed = (totals.heapUsed ?? 0) + heapUsed;
    }
    workers.set(worker.script, totals);
  }
  for (const worker of memory.workerMemoryMissing ?? []) {
    const totals = workers.get(worker.script) ?? { count: 0, sampled: 0, heapUsed: undefined };
    totals.count++;
    workers.set(worker.script, totals);
  }
  store.clearGauges("openclaw_worker_heap_used_bytes");
  for (const [script, totals] of workers) {
    store.gauge("openclaw_worker_count", "Worker isolate counts.", { script }, totals.count);
    store.gauge(
      "openclaw_worker_heap_sampled_count",
      "Worker isolate counts.",
      { script },
      totals.sampled,
    );
    store.gauge(
      "openclaw_worker_heap_used_bytes",
      "Latest live Worker heap usage by bounded script basename.",
      { script },
      totals.heapUsed,
    );
  }
  store.histogram(
    "openclaw_memory_rss_bytes",
    "RSS memory sample distribution in bytes.",
    {},
    numericValue(memory.rssBytes),
    byteBuckets,
  );
}
