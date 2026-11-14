/// <reference lib="es2024.arraybuffer" />
/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/prometheus-cardinality-measure.ts
 *   --output .local/cardinality/base.json [--compare .local/cardinality/base.json.prom]
 * Run the same script on both revisions, alternating order. The observed October 23
 * family counts use synthetic labels/values; worker requests go through the real
 * recorder. This is an owner benchmark, not a Gateway or production traffic replay.
 * Defaults: 10k warmup requests, 100k timed requests, 2k warm renders, separate allocation passes.
 * Require fewer rows/bytes and compare unprofiled CPU. --compare verifies every
 * preserved row byte-for-byte, excluding only the two removed finite-bucket sets.
 * --recorder <file> selects a saved recorder revision with resolvable imports;
 * keep the store/formatter unchanged when isolating a recorder-only change.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import shape from "../../extensions/diagnostics-prometheus/benchmarks/render-shape-2026-10-23.json" with { type: "json" };
import {
  PROMETHEUS_FAMILY_RESERVES,
  type PrometheusMetricName,
} from "../../extensions/diagnostics-prometheus/src/prometheus-family-budget.js";
import { createPrometheusMetricStore } from "../../extensions/diagnostics-prometheus/src/prometheus-metric-store.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    compare: { type: "string" },
    recorder: { type: "string" },
  },
});
assert(values.output, "--output is required");
const store = createPrometheusMetricStore();
const {
  createWorkerRequestMetricsRecorder,
}: typeof import("../../extensions/diagnostics-prometheus/src/service-worker.js") = await import(
  values.recorder
    ? pathToFileURL(resolve(values.recorder)).href
    : new URL("../../extensions/diagnostics-prometheus/src/service-worker.js", import.meta.url).href
);
const record = createWorkerRequestMetricsRecorder(store);
const workerFamilies = new Set([
  "openclaw_worker_request_seconds",
  "openclaw_worker_request_phase_seconds",
  "openclaw_worker_queue_wait_seconds",
  "openclaw_worker_queue_depth",
]);
const timing = {
  dispatched: 0,
  posted: 1,
  received: 3,
  inputReady: 6,
  executeStarted: 10,
  executeFinished: 15,
  replied: 21,
  replyReceived: 28,
};
const partialTiming = { ...timing, replyReceived: undefined };
const requests = Array.from({ length: 141 }, (_, index) => ({
  requestClass: `request-${index}`,
  timing: index < 74 ? timing : index === 74 ? partialTiming : undefined,
}));
function observe(index: number) {
  const request = requests[index % requests.length]!;
  record("sqlite_writer", request.requestClass, "completed", 0, 2, 28, request.timing);
}
for (const row of [...shape.histograms, ...shape.scalars]) {
  if (workerFamilies.has(row.name)) {
    continue;
  }
  assert(Object.hasOwn(PROMETHEUS_FAMILY_RESERVES, row.name));
  // This committed fixture names only registered exporter families.
  const name = row.name as PrometheusMetricName;
  for (let index = 0; index < row.labelSets; index++) {
    const labels = { kind: `kind-${index % 8}`, worker_slot: String(index) };
    if ("finiteBuckets" in row) {
      store.histogram(
        name,
        "Synthetic histogram",
        labels,
        0.005 * ((index % 17) + 1),
        row.finiteBuckets,
      );
    } else if (row.type === "counter") {
      store.counter(name, "Synthetic scalar", labels, index + 1);
    } else {
      store.gauge(name, "Synthetic scalar", labels, index + 1);
    }
  }
}
// The recorder adds the 23rd queue-depth label and all 141 request/queue labels.
for (let index = 0; index < 22; index++) {
  store.gauge("openclaw_worker_queue_depth", "Synthetic queue depth", { kind: `kind-${index}` }, 0);
}
requests.forEach((_, index) => observe(index));
const scrape = store.render().toString();
assert(!scrape.includes("openclaw_prometheus_series_dropped_total"), "Fixture dropped series");
const preserved = (text: string) =>
  text
    .split("\n")
    .filter(
      (line) =>
        !/^openclaw_worker_request(?:_phase)?_seconds_bucket\{/.test(line) ||
        line.includes('le="+Inf"'),
    )
    .join("\n");
if (values.compare) {
  assert.equal(preserved(scrape), preserved(await readFile(values.compare, "utf8")));
}
const inventory = new Map<
  string,
  { rows: number; bytes: number; labels: Set<string>; labelSets: Set<string> }
>();
for (const line of scrape.split("\n")) {
  if (line.startsWith("# TYPE ")) {
    inventory.set(line.split(" ")[2]!, {
      rows: 0,
      bytes: 0,
      labels: new Set(),
      labelSets: new Set(),
    });
  } else if (line && !line.startsWith("#")) {
    const metric = line.split(/[ {]/, 1)[0]!;
    const family = inventory.has(metric) ? metric : metric.replace(/_(bucket|sum|count)$/, "");
    const entry = inventory.get(family)!;
    entry.rows++;
    entry.bytes += Buffer.byteLength(line) + 1;
    const labels = [...line.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].filter(
      (match) => match[1] !== "le",
    );
    labels.forEach((match) => entry.labels.add(match[1]!));
    entry.labelSets.add(labels.map((match) => match[0]).join(","));
  }
}
function render() {
  const body = store.render();
  // Match successful HTTP response ownership without waiting for external GC.
  body.buffer.transfer(0);
}
function cpuPass(operations: number, action: (index: number) => void) {
  const hostLoad = loadavg();
  const cpu = process.cpuUsage();
  const threadCpu = process.threadCpuUsage();
  const started = performance.now();
  for (let index = 0; index < operations; index++) {
    action(index);
  }
  const used = process.cpuUsage(cpu);
  const threadUsed = process.threadCpuUsage(threadCpu);
  return {
    operations,
    cpuUsPerOperation: (used.user + used.system) / operations,
    threadCpuUsPerOperation: (threadUsed.user + threadUsed.system) / operations,
    wallMs: performance.now() - started,
    hostLoad,
  };
}
async function allocationPass(operations: number, action: (index: number) => void) {
  const inspector = new Session();
  inspector.connect();
  try {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let index = 0; index < operations; index++) {
      action(index);
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: typeof profile.head): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    return { operations, sampledHeapBytesPerOperation: sum(profile.head) / operations };
  } finally {
    inspector.disconnect();
  }
}
for (let index = 0; index < 10_000; index++) {
  observe(index);
}
for (let index = 0; index < 20; index++) {
  render();
}
const observationCpu = cpuPass(100_000, observe);
render();
const renderCpu = cpuPass(2000, render);
const observationAllocation = await allocationPass(10_000, observe);
// Refresh changed rows before measuring the same warm-render path.
render();
const renderAllocation = await allocationPass(500, render);
const report = {
  node: process.version,
  workload:
    "Observed family counts with synthetic labels; real recorder for worker request and phase metrics",
  rows: [...inventory.values()].reduce((sum, family) => sum + family.rows, 0),
  bytes: Buffer.byteLength(scrape),
  preservedSha256: createHash("sha256").update(preserved(scrape)).digest("hex"),
  memory: process.memoryUsage(),
  observationCpu,
  renderCpu,
  observationAllocation,
  renderAllocation,
  inventory: [...inventory]
    .map(([family, entry]) => ({
      family,
      rows: entry.rows,
      bytes: entry.bytes,
      labels: [...entry.labels].toSorted(),
      labelSets: entry.labelSets.size,
    }))
    .toSorted((a, b) => b.rows - a.rows),
};
await mkdir(dirname(values.output), { recursive: true });
await writeFile(`${values.output}.prom`, scrape);
await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    rows: report.rows,
    bytes: report.bytes,
    observationCpu,
    renderCpu,
    observationAllocation,
    renderAllocation,
  }),
);
