/**
 * Actor creation/release over 10,000 synthetic session identities. No SQL or
 * workspace reads occur in this owner. Measure timing and allocation separately:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-actor-creation-measure.mjs \
 *   --kind file --mode timing [--owner src/config/sessions/session-actor-executor.baseline.ts]
 * Repeat five alternating baseline/candidate pairs plus identical-source controls.
 * Baseline modules may be preserved alongside originals to retain relative imports.
 * Acceptance: mutation isolation, lower CPU/allocation, no material latency loss
 * beyond identical-source spread. This measures the shared admission owner, not SQL,
 * transport, or whole-Gateway turn latency; use the census preload for flow counts.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/config/sessions/session-actor-executor.ts" },
    kind: { type: "string", default: "file" },
    mode: { type: "string", default: "timing" },
    operations: { type: "string", default: "100000" },
  },
});
assert(["file", "memory"].includes(values.kind));
assert(["timing", "allocation"].includes(values.mode));
const operations = Number(values.operations);
assert(Number.isSafeInteger(operations) && operations > 0);
const { createSessionActorWithExecutor } = await import(
  pathToFileURL(path.resolve(values.owner)).href
);
const targets = Array.from({ length: 10000 }, (_, i) => ({
  sessionKey: `agent:synthetic:dashboard:session-${i}`,
  database:
    values.kind === "file"
      ? {
          kind: "file",
          physicalIdentity: "synthetic-team-database-identity",
          birthtime: "1800000000000",
          nativeLocation: "/synthetic/agents/synthetic/agent.sqlite",
        }
      : { kind: "memory", handle: "synthetic-memory-owner", incarnation: "synthetic-incarnation" },
}));
const lifetime = { assertCurrent() {}, assertReadable() {} };
const executor = {
  snapshot() {},
  snapshotEntry() {},
  async read() {
    throw new Error("Unused read");
  },
  async command() {
    throw new Error("Unused command");
  },
  async release() {},
};
const create = (target) =>
  createSessionActorWithExecutor({ target, lifetime, createExecutor: () => executor });
const input = structuredClone(targets[0]);
const check = create(input);
input.sessionKey = "changed";
assert.equal(Reflect.set(check.target, "sessionKey", "changed"), false);
assert.equal(Reflect.set(check.target.database, "kind", "changed"), false);
assert.deepEqual(check.target, targets[0]);
await check.release();
for (let i = 0; i < 10000; i++) {
  await create(targets[i]).release();
}
global.gc?.();
await setImmediate();
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const pauses = [];
const observer = new PerformanceObserver((list) => pauses.push(...list.getEntries()));
observer.observe({ entryTypes: ["gc"] });
const latencies = [];
const hostLoad = loadavg();
const cpu = process.threadCpuUsage();
const started = performance.now();
for (let i = 0; i < operations; i++) {
  const start = performance.now();
  const actor = create(targets[i % targets.length]);
  latencies.push(performance.now() - start);
  await actor.release();
  if (i % 1000 === 999) {
    await setImmediate();
  }
}
const elapsedMs = performance.now() - started;
const used = process.threadCpuUsage(cpu);
await setImmediate();
pauses.push(...observer.takeRecords());
observer.disconnect();
let allocatedBytes;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocatedBytes = sumSampledHeapBytes(profile.head);
  inspector.disconnect();
}
latencies.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    owner: values.owner,
    kind: values.kind,
    mode: values.mode,
    operations,
    targets: targets.length,
    cpuUsPerActor: (used.user + used.system) / operations,
    elapsedMs,
    creationMedianUs: latencies[Math.floor(operations * 0.5)] * 1000,
    creationP95Us: latencies[Math.floor(operations * 0.95)] * 1000,
    allocatedBytesPerActor: allocatedBytes === undefined ? undefined : allocatedBytes / operations,
    gc: {
      count: pauses.length,
      totalMs: pauses.reduce((s, p) => s + p.duration, 0),
      maxMs: Math.max(0, ...pauses.map((p) => p.duration)),
    },
    hostLoad,
    memory: process.memoryUsage(),
  }),
);
