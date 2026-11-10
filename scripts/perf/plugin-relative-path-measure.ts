/**
 * Plugin source relative-path owner benchmark, 40 synthetic plugin roots.
 * Run base/candidate owners alternately, with timing and allocation in separate passes:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-relative-path-measure.ts
 *   --owner src/plugins/path-safety.ts --iterations 10000 [--allocations]
 * A supplied owner must retain its original relative import resolution.
 * Warmup/forced GC are excluded. Reports main-thread CPU and sampled bytes per call;
 * this is not a whole-Gateway latency or production-frequency measurement.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/plugins/path-safety.ts" },
    iterations: { type: "string", default: "10000" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
assert(process.platform !== "win32", "This workload measures the POSIX branch");
const { relativePluginPathInsideRootSync: relative } = (await import(
  pathToFileURL(path.resolve(values.owner)).href
)) as typeof import("../../src/plugins/path-safety.js");
const fixtures = Array.from({ length: 40 }, (_, index) => {
  const root = `/synthetic/openclaw/node_modules/@openclaw/plugin-${index}`;
  return [root, `${root}/dist/runtime/nested/Entry.js`] as const;
});
let checksum = 0;
function run(count: number) {
  for (let index = 0; index < count; index++) {
    const [root, target] = fixtures[index % fixtures.length]!;
    checksum += relative(root, target)!.length;
  }
}
assert.equal(relative(...fixtures[0]!), "dist/runtime/nested/Entry.js");
run(2000);
global.gc();
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpuStart = process.threadCpuUsage();
const start = performance.now();
run(iterations);
const elapsedMs = performance.now() - start;
const cpu = process.threadCpuUsage(cpuStart);
let allocatedBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    owner: values.owner,
    node: process.version,
    iterations,
    hostLoad,
    elapsedMs,
    cpuUsPerCall: values.allocations ? undefined : (cpu.user + cpu.system) / iterations,
    bytesPerCall: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    checksum,
  }),
);
