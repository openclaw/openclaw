/**
 * Registry-only benchmark: 55 exact operation keys / 26 loader groups per agent.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/worker-operation-registry-measure.ts > result.json
 * Optional first argument selects a baseline registry module; default is current source.
 * Five untraced passes of 3,000 cold registries or warm 55-key scans; loaders/handlers prepared beforehand.
 * Per-kind GC durations; separate 4-KiB allocation sampling includes collected objects.
 * Retention keeps 1,000 prepared registries live through forced GC, then verifies release.
 * A unit is one registry or 55-key scan; CPU and wall time are separate. Lower cold
 * allocation/CPU and retention win; warm shifts are context. Excludes imports, SQL and Gateway latency.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { createWorkerOperationRegistry as Factory } from "../../src/state/worker-operation-registry.js";
const moduleUrl = process.argv[2]
  ? pathToFileURL(process.argv[2])
  : new URL("../../src/state/worker-operation-registry.ts", import.meta.url);
const { createWorkerOperationRegistry }: { createWorkerOperationRegistry: typeof Factory } =
  await import(moduleUrl.href);
const iterations = 3000,
  retainedCount = 1000;
const collect = global.gc;
assert(collect, "Run with --expose-gc");
type Operations = Record<string, { input: number; output: number }>;
type Context = { agentId: number };
// Multiplicities from createAgentWorkerOperationLoaders; names are synthetic exact keys.
const groups = [1, 2, 2, 2, 4, 2, 2, 2, 1, 1, 3, 2, 1, 6, 1, 1, 1, 1, 1, 2, 2, 4, 4, 2, 4, 1].map(
  (size, group) =>
    Array.from({ length: size }, (_, key) => `session.group${group}.operation${key}`),
);
let loaderCalls = 0;
const loaders = Object.fromEntries(
  groups.flatMap((keys) => {
    const handlers = Object.fromEntries(
      keys.map((key) => [key, (input: number, context: Context) => input + context.agentId]),
    );
    const load = async () => {
      loaderCalls++;
      return handlers;
    };
    return keys.map((key) => [key, load]);
  }),
);
const keys = groups.flat();
assert.equal(keys.length, 55);
const create = () => createWorkerOperationRegistry<Operations, Context, string>(loaders);
type Registry = ReturnType<typeof create>;
const prepare = (registry: Registry) =>
  Promise.all(keys.map((key) => registry.prepare(key) ?? Promise.resolve()));
const warm = create();
await prepare(warm);
const command = { type: keys[0]!, input: 17 },
  context = { agentId: 23 };
assert.equal(warm.execute(command, context), 40);
let checksum = 0;
async function run(mode: string, count: number) {
  for (let index = 0; index < count; index++) {
    const registry = mode === "cold" ? create() : warm;
    if (mode === "cold") {
      await prepare(registry);
    } else {
      for (const key of keys) {
        if (registry.prepare(key) !== undefined) {
          throw new Error("Warm preparation loaded a handler");
        }
      }
    }
    checksum += registry.execute(command, context);
  }
}
const gcEntries: Array<{ kind: number; duration: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = Reflect.get(entry, "detail") as { kind: number };
    gcEntries.push({ kind: detail.kind, duration: entry.duration });
  }
});
observer.observe({ entryTypes: ["gc"] });
const drain = () => setImmediate().then(() => setImmediate());
const forceGc = async () => {
  for (let index = 0; index < 2; index++) {
    collect();
    await drain();
  }
};
const perUnit = (value: number) => ({
  perUnit: value / iterations,
  perPrepareCall: value / iterations / keys.length,
});
const reports = [];
for (const mode of ["cold", "warm"]) {
  await run(mode, 200);
  const timing = [];
  for (let pass = 0; pass < 5; pass++) {
    await forceGc();
    gcEntries.length = 0;
    const calls = loaderCalls,
      load = loadavg(),
      cpu = process.cpuUsage(),
      thread = process.threadCpuUsage(),
      start = performance.now();
    await run(mode, iterations);
    const wallMs = performance.now() - start,
      threadUsed = process.threadCpuUsage(thread),
      cpuUsed = process.cpuUsage(cpu);
    await drain();
    timing.push({
      pass,
      wallMs,
      processCpuUs: perUnit(cpuUsed.user + cpuUsed.system),
      threadCpuUs: perUnit(threadUsed.user + threadUsed.system),
      loaderCalls: loaderCalls - calls,
      gc: gcEntries.slice(),
      load,
    });
  }
  await forceGc();
  const inspector = new Session();
  inspector.connect();
  let sampledBytes = 0;
  try {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await run(mode, iterations);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  } finally {
    inspector.disconnect();
  }
  reports.push({
    mode,
    iterations,
    preparesPerUnit: keys.length,
    timing,
    sampledBytes,
    allocationBytes: perUnit(sampledBytes),
  });
}
await forceGc();
const before = process.memoryUsage(),
  retained: Registry[] = [];
for (let index = 0; index < retainedCount; index++) {
  const registry = create();
  await prepare(registry);
  retained.push(registry);
}
await forceGc();
const held = process.memoryUsage();
for (const registry of retained) {
  checksum += registry.execute(command, context);
}
retained.length = 0;
await forceGc();
const released = process.memoryUsage();
observer.disconnect();
const retainedHeapBytes = held.heapUsed - before.heapUsed;
const retention = {
  registries: retainedCount,
  before,
  held,
  released,
  retainedHeapBytes,
  bytesPerRegistry: retainedHeapBytes / retainedCount,
};
console.log(JSON.stringify({ node: process.version, reports, retention, checksum }));
