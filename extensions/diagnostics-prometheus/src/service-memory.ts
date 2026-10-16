import { asNonNegativeFiniteNumber as numericValue } from "openclaw/plugin-sdk/number-runtime";
import type { DiagnosticEventPayload } from "../api.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

const WORKER_MEMORY_METRICS = [
  ["heapUsed", "openclaw_worker_heap_used_bytes", "heap usage"],
  ["external", "openclaw_worker_external_bytes", "external memory"],
  [
    "arrayBuffers",
    "openclaw_worker_array_buffers_bytes",
    "ArrayBuffer memory (included in external)",
  ],
] as const;

type WorkerMemoryTotals = {
  count: number;
  sampled: number;
  heapUsed?: number;
  external?: number;
  arrayBuffers?: number;
};

export function recordMemorySample(
  store: PrometheusMetricStore,
  memory: Extract<DiagnosticEventPayload, { type: "diagnostic.memory.sample" }>["memory"],
  byteBuckets: number[],
): void {
  for (const message of memory.workerMessages ?? []) {
    const labels = { kind: message.kind, direction: message.direction };
    store.counterValue(
      "openclaw_worker_messages_total",
      "Messages crossing the Gateway main-thread worker boundary.",
      labels,
      message.messages,
    );
    store.counterValue(
      "openclaw_worker_message_payload_bytes_total",
      "Known worker payload bytes, excluding transport framing and unmeasured object graphs.",
      labels,
      message.payloadBytes,
    );
    store.counterValue(
      "openclaw_worker_message_unmeasured_total",
      "Worker messages without a known payload size; these do not contribute to payload bytes.",
      labels,
      message.unmeasuredMessages,
    );
  }
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
  const workers = new Map<string, WorkerMemoryTotals>();
  store.clearGauges("openclaw_code_mode_worker_heap_bytes");
  store.clearGauges("openclaw_code_mode_worker_memory_bytes");
  for (const worker of memory.workerHeaps ?? []) {
    if (worker.workerSlot !== undefined) {
      for (const [kind, value] of [
        ["used", worker.heapUsed],
        ["limit", worker.heapSizeLimitBytes],
      ] as const) {
        store.gauge(
          "openclaw_code_mode_worker_heap_bytes",
          "Latest live Code Mode isolate heap usage and limit by reusable worker slot.",
          { slot: String(worker.workerSlot), kind },
          value,
        );
      }
      for (const [kind, value] of [
        ["external", worker.external],
        ["array_buffers", worker.arrayBuffers],
      ] as const) {
        store.gauge(
          "openclaw_code_mode_worker_memory_bytes",
          "Latest live Code Mode isolate external and ArrayBuffer memory (included in external) by reusable worker slot.",
          { slot: String(worker.workerSlot), kind },
          value,
        );
      }
    }
    const totals: WorkerMemoryTotals = workers.get(worker.script) ?? { count: 0, sampled: 0 };
    totals.count++;
    totals.sampled++;
    for (const [field] of WORKER_MEMORY_METRICS) {
      const value = worker[field];
      if (value !== undefined) {
        totals[field] = (totals[field] ?? 0) + value;
      }
    }
    workers.set(worker.script, totals);
  }
  for (const worker of memory.workerMemoryMissing ?? []) {
    const totals = workers.get(worker.script) ?? { count: 0, sampled: 0 };
    totals.count++;
    workers.set(worker.script, totals);
  }
  for (const [, name] of WORKER_MEMORY_METRICS) {
    store.clearGauges(name);
  }
  for (const [script, totals] of workers) {
    store.gauge("openclaw_worker_count", "Worker isolate counts.", { script }, totals.count);
    store.gauge(
      "openclaw_worker_heap_sampled_count",
      "Worker isolate counts.",
      { script },
      totals.sampled,
    );
    for (const [field, name, description] of WORKER_MEMORY_METRICS) {
      store.gauge(
        name,
        `Latest live Worker ${description} by bounded script basename.`,
        { script },
        totals[field],
      );
    }
  }
  store.histogram(
    "openclaw_memory_rss_bytes",
    "RSS memory sample distribution in bytes.",
    {},
    numericValue(memory.rssBytes),
    byteBuckets,
  );
}
