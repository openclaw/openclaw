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
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount++;
      gcMs += entry.duration;
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
  const retainedStart = startAt + phaseIndex * 15000 - Date.now();
  assert(retainedStart > 0, "Missed the paired retained-size start");
  await delay(retainedStart);
  const retainedStore = createPrometheusMetricStore();
  globalThis.gc!();
  const emptyHeap = process.memoryUsage().heapUsed;
  const families = Object.keys(PROMETHEUS_FAMILY_RESERVES) as PrometheusMetricName[];
  const maxReserve = Math.max(...Object.values(PROMETHEUS_FAMILY_RESERVES));
  let series = 0;
  // Populate every reserve before using shared capacity. Keep the retained-size
  // workload at exactly 2048 entries under both old and partitioned admission.
  for (let pass = 0; series < 2048; pass++) {
    for (const [familyIndex, name] of families.entries()) {
      const reserve = PROMETHEUS_FAMILY_RESERVES[name];
      const label = pass < maxReserve ? pass : reserve + pass - maxReserve;
      if (
        (pass < maxReserve && pass >= reserve) ||
        label >= Math.max(MAX_PROMETHEUS_FAMILY_SERIES, reserve)
      ) {
        continue;
      }
      if (series === 2048) {
        break;
      }
      const labels = { kind: `kind-${label % 8}`, worker_slot: String(label) };
      if (familyIndex % 4 === 0) {
        retainedStore.counter(name, "Retained counter", labels);
      } else if (familyIndex % 4 === 1) {
        retainedStore.gauge(name, "Retained gauge", labels, 2);
      } else {
        retainedStore.histogram(name, "Retained histogram", labels, 0.005);
      }
      series++;
    }
  }
  globalThis.gc!();
  const populatedHeap = process.memoryUsage().heapUsed;
  assert(!retainedStore.render().includes("openclaw_prometheus_series_dropped_total"));
  // The reset keeps the same store strongly reachable and releases its series ownership.
  retainedStore.reset();
  globalThis.gc!();
  results.retained = {
    series: 2048,
    bytes: populatedHeap - emptyHeap,
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
