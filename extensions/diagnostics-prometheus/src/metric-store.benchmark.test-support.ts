// Run on an approved benchmark host with --expose-gc --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  MAX_PROMETHEUS_FAMILY_SERIES,
  PROMETHEUS_FAMILY_RESERVES,
  SHARED_PROMETHEUS_SERIES,
  type PrometheusMetricName,
} from "./prometheus-family-budget.js";
import { createPrometheusMetricStore } from "./prometheus-metric-store.js";
import { recordWorkerRequest } from "./service-worker.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    iterations: { type: "string", default: "100000" },
    "start-at": { type: "string" },
  },
});
assert(values.output, "--output is required");
assert(globalThis.gc, "Run with --expose-gc");
const iterations = Number(values.iterations);
assert(
  Number.isSafeInteger(iterations) && iterations >= 1000,
  "--iterations must be an integer >= 1000",
);
const startAt = values["start-at"] ? Number(values["start-at"]) : Date.now() + 1000;
assert(Number.isSafeInteger(startAt), "--start-at must be an epoch millisecond integer");
let phaseIndex = 0;
const session = new Session();
session.connect();
await session.post("HeapProfiler.enable");
const results: Record<string, unknown> = {};
async function measure(name: string, operations: number, run: () => Promise<void> | void) {
  // Separate phase starts keep both sides under the same competing host workload.
  const remaining = startAt + phaseIndex++ * 15000 - Date.now();
  assert(remaining > 0, `Missed the paired ${name} start`);
  await delay(remaining);
  globalThis.gc!();
  await immediate();
  let gcCount = 0;
  let gcMs = 0;
  let gcMaxMs = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount++;
      gcMs += entry.duration;
      gcMaxMs = Math.max(gcMaxMs, entry.duration);
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const cpu = process.cpuUsage();
  const started = performance.now();
  await run();
  const wallMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const { profile } = await session.post("HeapProfiler.stopSampling");
  await immediate();
  await immediate();
  observer.disconnect();
  type AllocationNode = { selfSize: number; children: AllocationNode[] };
  const allocated = (node: AllocationNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
  const sampledBytes = allocated(profile.head);
  results[name] = {
    operations,
    sampledBytes,
    bytesPerOperation: sampledBytes / operations,
    wallMs,
    cpuMs: (used.user + used.system) / 1000,
    gcCount,
    gcMs,
    gcMaxMs,
  };
}

try {
  const store = createPrometheusMetricStore();
  const observe = (count: number) => {
    for (let index = 0; index < count; index++) {
      // Fresh labels and alternating property order match actual producer behavior.
      const labels =
        index % 2
          ? { kind: "sqlite_read", phase: "completed" }
          : { phase: "completed", kind: "sqlite_read" };
      store.counter("openclaw_worker_tasks_completed_total", "Synthetic count", labels);
      store.gauge("openclaw_worker_queue_depth", "Synthetic depth", labels, 2);
      store.histogram("openclaw_worker_request_seconds", "Synthetic duration", labels, 0.005);
    }
  };
  observe(2000);
  await measure("prometheus.observation", iterations * 3, () => observe(iterations));
  const workerStore = createPrometheusMetricStore();
  const record = (count: number) => {
    for (let index = 0; index < count; index++) {
      recordWorkerRequest(workerStore, {
        type: "worker.request",
        ts: 1,
        seq: index,
        kind: "sqlite_read",
        phase: "completed",
        requestClass: "sessions.get",
        queueDepth: 0,
        queueWaitMs: 0.1,
        durationMs: 1,
      });
    }
  };
  record(2000);
  await measure("prometheus.worker-request", iterations, () => record(iterations));
  const fixed = createPrometheusMetricStore();
  for (const labels of [
    { z: 'quote"backslash\\newline\n', a: "" },
    { a: "", z: 'quote"backslash\\newline\n' },
    { a: "one|two", z: "three" },
    { z: "two|three", a: "one" },
  ]) {
    fixed.counter("openclaw_run_completed_total", "Synthetic \\ help\n", labels, 2);
    fixed.counterValue("openclaw_worker_tasks_completed_total", "Absolute", labels, 4);
    fixed.gauge("openclaw_worker_queue_depth", "Depth", labels, -2);
    fixed.histogram("openclaw_run_duration_seconds", "Duration", labels, 0.015);
  }
  const scrape = fixed.render();
  const renders = Math.max(1000, Math.floor(iterations / 10));
  await measure("prometheus.render", renders, () => {
    for (let index = 0; index < renders; index++) {
      assert.equal(fixed.render(), scrape);
    }
  });
  const retainedStart = startAt + phaseIndex++ * 15000 - Date.now();
  assert(retainedStart > 0, "Missed the paired retained-size start");
  await delay(retainedStart);
  const retainedStore = createPrometheusMetricStore();
  const families = Object.keys(PROMETHEUS_FAMILY_RESERVES) as PrometheusMetricName[];
  const reserves = Object.values(PROMETHEUS_FAMILY_RESERVES);
  const maxReserve = Math.max(...reserves);
  const capacity = reserves.reduce((sum, reserve) => sum + reserve, 0) + SHARED_PROMETHEUS_SERIES;
  const rpcDurationBuckets = [
    0.005, 0.01, 0.0125, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.125, 0.15, 0.2,
    0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12.5, 15, 20, 25, 30,
    60, 120, 300, 600,
  ];
  const responseByteBuckets = Array.from({ length: 17 }, (_, index) => 1024 * 2 ** index);
  const heapDeltaBuckets = [
    ...responseByteBuckets.toReversed().map((bytes) => -bytes),
    0,
    ...responseByteBuckets,
  ];
  const rpcBuckets: Partial<Record<PrometheusMetricName, number[]>> = {
    openclaw_gateway_rpc_admission_seconds: rpcDurationBuckets,
    openclaw_gateway_rpc_first_response_seconds: rpcDurationBuckets,
    openclaw_gateway_rpc_handler_seconds: rpcDurationBuckets,
    openclaw_gateway_rpc_queue_wait_seconds: rpcDurationBuckets,
    openclaw_gateway_rpc_response_bytes: responseByteBuckets,
    openclaw_gateway_rpc_handler_heap_delta_bytes: heapDeltaBuckets,
  };
  globalThis.gc!();
  const emptyHeap = process.memoryUsage().heapUsed;
  let series = 0;
  let scalarSeries = 0;
  let histogramSeries = 0;
  // Populate every reserve before using shared capacity, up to the loaded budget.
  for (let pass = 0; series < capacity; pass++) {
    for (const [familyIndex, name] of families.entries()) {
      const reserve = PROMETHEUS_FAMILY_RESERVES[name];
      const label = pass < maxReserve ? pass : reserve + pass - maxReserve;
      if (
        (pass < maxReserve && pass >= reserve) ||
        label >= Math.max(MAX_PROMETHEUS_FAMILY_SERIES, reserve)
      ) {
        continue;
      }
      if (series === capacity) {
        break;
      }
      const labels = { kind: `kind-${label % 8}`, worker_slot: String(label) };
      const buckets = rpcBuckets[name];
      if (buckets || familyIndex % 4 >= 2) {
        retainedStore.histogram(name, "Retained histogram", labels, 0.005, buckets);
        histogramSeries++;
      } else if (familyIndex % 4 === 0) {
        retainedStore.counter(name, "Retained counter", labels);
        scalarSeries++;
      } else if (familyIndex % 4 === 1) {
        retainedStore.gauge(name, "Retained gauge", labels, 2);
        scalarSeries++;
      }
      series++;
    }
  }
  globalThis.gc!();
  const populatedHeap = process.memoryUsage().heapUsed;
  let fullScrape = retainedStore.render();
  assert(!fullScrape.includes("openclaw_prometheus_series_dropped_total"));
  const renderedBytes = Buffer.byteLength(fullScrape);
  const renderedRows = fullScrape
    .split("\n")
    .filter((line) => line && !line.startsWith("#")).length;
  const renderedLength = fullScrape.length;
  fullScrape = "";
  for (let index = 0; index < 10; index++) {
    retainedStore.render();
  }
  globalThis.gc!();
  const warmedHeap = process.memoryUsage().heapUsed;
  const fullRenderStart = startAt + phaseIndex++ * 15000 - Date.now();
  assert(fullRenderStart > 0, "Missed the paired full-capacity render start");
  await delay(fullRenderStart);
  let gcCount = 0;
  let gcMs = 0;
  let gcMaxMs = 0;
  let ended = Infinity;
  const durations: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.startTime >= started && entry.startTime < ended) {
        gcCount++;
        gcMs += entry.duration;
        gcMaxMs = Math.max(gcMaxMs, entry.duration);
      }
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < 200; index++) {
    const before = performance.now();
    const rendered = retainedStore.render();
    durations.push(performance.now() - before);
    assert.equal(rendered.length, renderedLength);
  }
  ended = performance.now();
  const used = process.cpuUsage(cpu);
  await immediate();
  await immediate();
  observer.disconnect();
  durations.sort((left, right) => left - right);
  results["prometheus.full-capacity-render"] = {
    samples: durations.length,
    meanMs: durations.reduce((sum, ms) => sum + ms, 0) / durations.length,
    medianMs: (durations[99]! + durations[100]!) / 2,
    p95Ms: durations[189],
    maxMs: durations.at(-1),
    wallMs: ended - started,
    cpuMs: (used.user + used.system) / 1000,
    gcCount,
    gcMs,
    gcMaxMs,
  };
  // The reset keeps the same store strongly reachable and releases its series ownership.
  retainedStore.reset();
  globalThis.gc!();
  results.retained = {
    series,
    scalarSeries,
    histogramSeries,
    workload:
      "Mixed scalar/histogram saturation with production RPC bucket widths; not a production traffic replay.",
    bytes: populatedHeap - emptyHeap,
    warmedBytes: warmedHeap - emptyHeap,
    renderedRows,
    renderedBytes,
    afterResetBytes: process.memoryUsage().heapUsed - emptyHeap,
  };
  assert.equal(retainedStore.render(), "");
  await writeFile(`${values.output}.prom`, scrape);
  await writeFile(
    values.output,
    JSON.stringify(
      {
        node: process.version,
        iterations,
        samplingInterval: 4096,
        includeCollectedObjects: true,
        results,
        scrape: {
          sha256: createHash("sha256").update(scrape).digest("hex"),
          bytes: Buffer.byteLength(scrape),
        },
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  session.disconnect();
}
