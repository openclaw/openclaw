/**
 * Isolated Jiti stack-format benchmark; no Gateway or external provider is contacted.
 * node --expose-gc --trace-gc-nvp scripts/perf/jiti-stack-format.ts \
 *   --factory ./src/plugins/jiti-factory.ts --mode timing --iterations 10000
 * Run timing, allocation and survivors separately, counterbalancing base/candidate order.
 * Allocation includes collected objects; survivors excludes minor-collected objects.
 * GC trace allocated/promoted counters are delimited by MEASURE_START/MEASURE_END.
 * Both revisions retain 50 frames and the same 128 most recent materialized stacks.
 * Run with native Node type stripping; tooling source-map hooks change the measured formatter.
 * Omit --trace-gc-nvp for CPU timing. Traced runs include two final forced minor GCs;
 * report their promotion separately from natural-work GC. CPU is process-wide.
 */
import { createHash } from "node:crypto";
import type { HeapProfiler } from "node:inspector";
import inspector from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import v8 from "node:v8";

/* oxlint-disable typescript/unbound-method -- Compare V8's formatter callback by identity before/after loading. */

const { values } = parseArgs({
  options: {
    factory: { type: "string", default: "./src/plugins/jiti-factory.ts" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "10000" },
  },
});
const iterations = Number(values.iterations);
if (!Number.isSafeInteger(iterations) || iterations < 1 || !global.gc) {
  throw new Error("Positive --iterations and --expose-gc are required");
}
if (!["timing", "allocation", "survivors"].includes(values.mode)) {
  throw new Error("--mode must be timing, allocation, or survivors");
}
const { createJiti }: typeof import("../../src/plugins/jiti-factory.js") = await import(
  pathToFileURL(path.resolve(values.factory)).href
);
const previous = Error.prepareStackTrace;
const loader = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
loader.transform({ source: "export const value: number = 42;", filename: "plugin.ts", ts: true });
const formatter = Error.prepareStackTrace;
const stacks = Array.from({ length: 128 }, () => "");
function formatToolError(depth: number): string {
  return depth > 0 ? formatToolError(depth - 1) : new Error("Synthetic tool failure").stack!;
}
function work(count: number) {
  let characters = 0;
  for (let index = 0; index < count; index++) {
    const stack = formatToolError(35);
    stacks[index % stacks.length] = stack;
    characters += stack.length;
  }
  return characters;
}
work(2000);
global.gc();
const session = new inspector.Session();
if (values.mode !== "timing") {
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: values.mode === "allocation",
  });
}
global.gc({ type: "minor", execution: "sync" });
const beforeHeap = v8.getHeapStatistics().used_heap_size;
console.log("MEASURE_START");
const cpu = process.cpuUsage();
const started = performance.now();
const characters = work(iterations);
const elapsedMs = performance.now() - started;
const usedCpu = process.cpuUsage(cpu);
// Flush nursery survivors while keeping the same final stack snapshots reachable.
global.gc({ type: "minor", execution: "sync" });
global.gc({ type: "minor", execution: "sync" });
const flushedCpu = process.cpuUsage(cpu);
console.log("MEASURE_END");
const afterHeap = v8.getHeapStatistics().used_heap_size;
let sampledBytes: number | undefined;
if (values.mode !== "timing") {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  const total = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + total(child), 0);
  sampledBytes = total(profile.head);
  session.disconnect();
}
console.log(
  JSON.stringify({
    mode: values.mode,
    iterations,
    formatterRestored: formatter === previous,
    stackTraceLimit: Error.stackTraceLimit,
    elapsedMs,
    cpuUsPerOperation: (usedCpu.user + usedCpu.system) / iterations,
    cpuIncludingFlushUsPerOperation: (flushedCpu.user + flushedCpu.system) / iterations,
    sampledBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    beforeHeap,
    afterHeap,
    characters,
    retainedStacks: stacks.length,
    stackDigest: createHash("sha256").update(stacks.join("\n")).digest("hex"),
    hostLoad: loadavg(),
  }),
);
