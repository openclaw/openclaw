/**
 * Cron read-owner workload: two interleaved stores of 200 jobs with 1 KiB payloads.
 * Each operation enters the real lock without publishing a change, then lists 25
 * rows. Every 50 operations per store publishes one changed worker postimage.
 * This models no-op scheduler/CRUD invalidation, not worker or Gateway latency.
 * Add --query synthetic to measure repeated search preparation within each revision.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-list-revision-measure.ts \
 *   --mode timing --output .local/cron-revision/head.json
 * Run five counterbalanced serial pairs and matched A/A controls. Separate modes:
 * allocation includes collected objects; promotion needs --trace-gc-nvp and
 * --gc-log pointing at redirected stdout. --lock accepts the baseline locked.ts
 * with its relative imports resolved to the same checkout. All other code stays
 * identical. --read likewise accepts a baseline ops-read.ts with resolved imports.
 * Compare rowDigest, publications, operations, and listPreparations.
 * coldRead includes initial store admission and full first-page preparation.
 * mainThreadCpuMsPerOperation separates owner CPU from loader/worker threads.
 * Row snapshots are retained for the current inventory; report cold and warm costs.
 * Decide on allocation/operation and CPU/operation with GC, promotion, latency,
 * loop tails and maxima under the campaign's absolute-materiality thresholds.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { writeGatewayGcTraceMarker, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { recordGcCollections } from "../lib/perf-gc-collections.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    output: { type: "string" },
    lock: { type: "string" },
    query: { type: "string" },
    read: { type: "string" },
    operations: { type: "string", default: "2000" },
    "gc-log": { type: "string" },
  },
});
assert(["timing", "allocation", "promotion"].includes(values.mode));
assert(values.output, "--output is required");
assert(values.mode !== "timing" || !process.execArgv.some((arg) => arg.startsWith("--trace-gc")));
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
process.env.OPENCLAW_STATE_DIR = path.join(path.dirname(output), "synthetic-state");
process.env.OPENCLAW_CONFIG_PATH = path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json");
const operations = parseStrictIntegerOption({
  raw: values.operations,
  label: "--operations",
  min: 1,
  fallback: 2000,
});
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const { createCronServiceState } = await import("../../src/cron/service/state.js");
const readUrl = values.read
  ? pathToFileURL(path.resolve(values.read))
  : new URL("../../src/cron/service/ops-read.ts", import.meta.url);
const { listPage }: typeof import("../../src/cron/service/ops-read.js") = await import(
  readUrl.href
);
const { applyCronRuntimeRowsToState } =
  await import("../../src/cron/service/runtime-publication.js");
const lockUrl = values.lock
  ? pathToFileURL(path.resolve(values.lock))
  : new URL("../../src/cron/service/locked.ts", import.meta.url);
const { locked }: typeof import("../../src/cron/service/locked.js") = await import(lockUrl.href);
const scheduler = new GatewayScheduler();
const stores = Array.from({ length: 2 }, (_, storeIndex) => {
  const state = createCronServiceState({
    scheduler,
    storePath: path.join(process.env.OPENCLAW_STATE_DIR!, `store-${storeIndex}`, "jobs.json"),
    cronEnabled: true,
    defaultAgentId: "main",
    nowMs: () => 1_800_000_000_000,
    enqueueSystemEvent() {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  state.schedulerStarted = true;
  state.store = {
    version: 1,
    jobs: Array.from({ length: 200 }, (_entry, index) => ({
      id: `job-${storeIndex}-${index.toString().padStart(3, "0")}`,
      name: `Synthetic ${index.toString().padStart(3, "0")}`,
      enabled: true,
      createdAtMs: 1_800_000_000_000,
      updatedAtMs: 1_800_000_000_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "synthetic 🦞 payload\n".repeat(64).slice(0, 1024) },
      state: { nextRunAtMs: 1_800_000_060_000 + index },
    })),
  };
  return state;
});
let publications = 0;
let listPreparations = 0;
let rowDigest = createHash("sha256");
let revisionDigest = createHash("sha256");
async function run(operation: number) {
  const state = stores[operation % stores.length]!;
  const round = Math.floor(operation / stores.length);
  const previousList = state.readSnapshot?.lists[0];
  await locked(state, async () => {
    if (round > 0 && round % 50 === 0) {
      const job = state.store!.jobs[(round / 50) % 200]!;
      applyCronRuntimeRowsToState(state, [
        {
          ...job,
          state: { ...job.state, lastStatus: "ok", lastRunAtMs: 1_800_000_000_000 + round },
        },
      ]);
      publications++;
    }
  });
  const page = await listPage(state, { sortBy: "name", limit: 25, query: values.query });
  if (state.readSnapshot?.lists[0] !== previousList) {
    listPreparations++;
  }
  assert.equal(page.total, 200);
  assert.equal(page.jobs.length, 25);
  revisionDigest.update(page.snapshotRevision);
  rowDigest.update(JSON.stringify(page.jobs.map((job) => [job.id, job.state.lastRunAtMs])));
}
global.gc?.();
const coldHeap = process.memoryUsage().heapUsed;
const coldCpu = process.cpuUsage();
const coldStart = performance.now();
for (let i = 0; i < stores.length; i++) {
  await run(i);
}
const coldElapsedMs = performance.now() - coldStart;
const coldUsedCpu = process.cpuUsage(coldCpu);
global.gc?.();
const coldRead = {
  operations: stores.length,
  elapsedMs: coldElapsedMs,
  cpuMs: (coldUsedCpu.user + coldUsedCpu.system) / 1000,
  retainedHeapBytes: process.memoryUsage().heapUsed - coldHeap,
};
const warmup = 100;
for (let i = 0; i < warmup; i++) {
  await run(i);
}
publications = 0;
listPreparations = 0;
revisionDigest = createHash("sha256");
rowDigest = createHash("sha256");
const profilePath = `${output}.heapprofile`;
if (values.mode === "promotion") {
  assert(values["gc-log"] && global.gc, "promotion requires --gc-log and --expose-gc");
  writeGatewayGcTraceMarker("identify-start", profilePath);
  global.gc();
  writeGatewayGcTraceMarker("identify-stop", profilePath);
}
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    totalMs: sorted.reduce((a, b) => a + b, 0),
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    maxMs: sorted.at(-1) ?? 0,
  };
}
const collections: { kind: number; ms: number }[] = [];
let measuredStart = Infinity;
let measuredEnd = Infinity;
const observer = new PerformanceObserver((list) =>
  recordGcCollections(list.getEntries(), collections, measuredStart, measuredEnd),
);
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
observer.observe({ entryTypes: ["gc"] });
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
await delay(10);
loop.reset();
const outsideLoad = loadavg();
const cpu = process.cpuUsage();
const mainCpu = process.threadCpuUsage();
const latencies: number[] = [];
writeGatewayGcTraceMarker("heap-start", profilePath);
measuredStart = performance.now();
for (let i = 0; i < operations; i++) {
  const started = performance.now();
  await run(i + warmup);
  latencies.push(performance.now() - started);
  await nextTurn();
}
measuredEnd = performance.now();
writeGatewayGcTraceMarker("heap-stop", profilePath);
const usedCpu = process.cpuUsage(cpu);
const usedMainCpu = process.threadCpuUsage(mainCpu);
loop.disable();
await nextTurn();
await nextTurn();
observer.disconnect();
const profile =
  values.mode === "allocation"
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
if (values.mode === "allocation") {
  inspector.disconnect();
}
let sampledBytes = 0;
if (profile) {
  const visit = (node: HeapProfiler.SamplingHeapProfileNode) => {
    sampledBytes += node.selfSize;
    node.children.forEach(visit);
  };
  visit(profile.head);
  await writeFile(profilePath, JSON.stringify(profile));
}
const gc = (kind?: number) =>
  distribution(
    collections
      .filter((entry) => kind === undefined || entry.kind === kind)
      .map((entry) => entry.ms),
  );
const promotion =
  values.mode === "promotion"
    ? readGatewayGcTrace(path.resolve(values["gc-log"]!), profilePath)
    : null;
const report = {
  scope: "cron lock/read owner; synthetic postimages; no worker or Gateway latency claim",
  mode: values.mode,
  node: process.version,
  platform: process.platform,
  lock: lockUrl.href,
  read: readUrl.href,
  query: values.query ?? null,
  stores: stores.length,
  jobsPerStore: 200,
  warmup,
  operations,
  publications,
  listPreparations,
  coldRead,
  memory: process.memoryUsage(),
  rowDigest: rowDigest.digest("hex"),
  revisionDigest: revisionDigest.digest("hex"),
  outsideLoad,
  elapsedMs: measuredEnd - measuredStart,
  mainThreadCpuMsPerOperation: (usedMainCpu.user + usedMainCpu.system) / 1000 / operations,
  cpuMsPerOperation: (usedCpu.user + usedCpu.system) / 1000 / operations,
  latency: distribution(latencies),
  gc: {
    total: gc(),
    msPerOperation: gc().totalMs / operations,
    minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
    major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
    incremental: gc(constants.NODE_PERFORMANCE_GC_INCREMENTAL),
    weak: gc(constants.NODE_PERFORMANCE_GC_WEAKCB),
  },
  eventLoop: {
    count: loop.count,
    p95Ms: loop.percentile(95) / 1e6,
    p99Ms: loop.percentile(99) / 1e6,
    maxMs: loop.max / 1e6,
  },
  allocation: profile ? { sampledBytes, bytesPerOperation: sampledBytes / operations } : null,
  promotion: promotion
    ? { ...promotion, bytesPerOperation: promotion.promotedBytes / operations }
    : null,
};
await scheduler.stop();
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
