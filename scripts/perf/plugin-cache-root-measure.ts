/**
 * Plugin metadata root allocation/retention, with no filesystem I/O or mock owners.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-cache-root-measure.ts
 *   [--owner .local/plugin-cache-base.ts] [--allocations]
 * Save src/plugins/plugin-cache.ts before editing for --owner; the load hook keeps
 * its original import resolution. Run five AB/BA pairs in each mode, serially.
 * Each side acquires 4,000 roots in ten fresh generations after one warm generation.
 * CPU excludes verification/GC; sampling is a separate diagnostic pass. Retention
 * keeps only the final generation. This does not measure Gateway latency.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";

const { values } = parseArgs({
  options: { owner: { type: "string" }, allocations: { type: "boolean" } },
});
const gc = globalThis.gc;
assert(gc, "Use --expose-gc");
const ownerUrl = new URL("../../src/plugins/plugin-cache.ts", import.meta.url).href;
const wasOwnerReplaced = registerPerfOwnerReplacement(ownerUrl, values.owner);
const { createPluginCache, getPluginCacheRoot, withPluginCache } =
  await import("../../src/plugins/plugin-cache.js");
assert(!values.owner || wasOwnerReplaced(), "Baseline owner was not loaded");
const roots = Array.from(
  { length: 4000 },
  (_, index) => `/synthetic/plugins/${index % 40}/${index}`,
);
const iterations = 10;
function acquire() {
  const cache = createPluginCache();
  withPluginCache(cache, () => {
    for (const root of roots) {
      getPluginCacheRoot(root);
    }
  });
  return cache;
}
async function collect() {
  await setImmediate();
  gc!();
  gc!();
}
acquire();
await collect();
const heapBefore = process.memoryUsage().heapUsed;
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
let cache: ReturnType<typeof acquire> | undefined;
const hostLoad = loadavg();
const cpu = process.threadCpuUsage();
const started = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
  cache = acquire();
}
const wallMs = performance.now() - started;
const used = process.threadCpuUsage(cpu);
const allocatedBytes = values.allocations
  ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
  : undefined;
inspector.disconnect();
await collect();
const retainedHeapBytes = process.memoryUsage().heapUsed - heapBefore;
assert(cache);
assert.equal(cache.roots.size, roots.length);
withPluginCache(cache, () => {
  for (const root of roots) {
    assert.equal(getPluginCacheRoot(root), cache.roots.get(root));
  }
});
console.log(
  JSON.stringify({
    mode: values.allocations ? "allocation" : "timing",
    owner: values.owner ?? "candidate",
    roots: roots.length,
    iterations,
    acquisitions: roots.length * iterations,
    cpuMs: (used.user + used.system) / 1000,
    wallMs,
    allocatedBytes,
    retainedHeapBytes,
    hostLoad,
  }),
);
