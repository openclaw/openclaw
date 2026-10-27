/**
 * Trajectory tool preparation owner microbenchmark; no Gateway or provider calls.
 * Run: node --expose-gc --import ./scripts/tsx.mjs
 *   scripts/perf/trajectory-tool-parameters-measure.ts [timing|allocation] [1000] [published]
 * Use separate timing/allocation processes and five alternating base/candidate pairs.
 * To overlay baseline runtime.ts, set OPENCLAW_BENCH_BASELINE_DIR to an absolute
 * directory containing src/trajectory/runtime.ts and additionally preload
 * ./scripts/perf/worker-retained-heap-preload.ts. An empty overlay is the candidate.
 * Forty synthetic tools with nested schemas model a compiled-context catalog.
 * Allocation sampling includes collected objects; profiled CPU is not timing evidence.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { GCProfiler } from "node:v8";
import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { toTrajectoryToolDefinitions } from "../../src/trajectory/runtime.js";

const mode = process.argv[2] ?? "timing";
const iterations = Number(process.argv[3] ?? 1000);
const published = process.argv[4] === "published";
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Use --expose-gc");
const tools = Array.from({ length: 40 }, (_, tool) => {
  const parameters = {
    type: "object",
    description: `Synthetic tool ${tool}`,
    properties: Object.fromEntries(
      Array.from({ length: 12 }, (_entry, field) => [
        `field${field}`,
        { type: "string", description: `Synthetic field ${field}`, enum: ["first", "second"] },
      ]),
    ),
    required: ["field0"],
    additionalProperties: false,
  };
  return {
    name: `tool-${String(tool).padStart(2, "0")}`,
    parameters: published ? publishRuntimeToolInputSchema(parameters).schema : parameters,
  };
});
const expected = JSON.stringify(tools);
for (let iteration = 0; iteration < 100; iteration++) {
  assert.equal(JSON.stringify(toTrajectoryToolDefinitions(tools)), expected);
}
global.gc();
const inspector = new Session();
if (mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const gc = new GCProfiler();
gc.start();
const loadBefore = os.loadavg();
const cpuBefore = process.threadCpuUsage();
const started = performance.now();
let result: ReturnType<typeof toTrajectoryToolDefinitions> = [];
for (let iteration = 0; iteration < iterations; iteration++) {
  result = toTrajectoryToolDefinitions(tools);
}
const elapsedMs = performance.now() - started;
const cpu = process.threadCpuUsage(cpuBefore);
const collections = gc.stop()?.statistics ?? [];
let sampledBytes: number | undefined;
let samples: number | undefined;
if (mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  samples = profile.samples.length;
  inspector.disconnect();
}
assert.equal(JSON.stringify(result), expected);
console.log(
  JSON.stringify({
    mode,
    published,
    iterations,
    tools: tools.length,
    node: process.version,
    elapsedMs,
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    sampledBytes,
    samples,
    gc: [...new Set(collections.map((entry) => entry.gcType))].map((kind) => {
      const pauses = collections
        .filter((entry) => entry.gcType === kind)
        .map((entry) => entry.cost / 1000);
      return {
        kind,
        count: pauses.length,
        totalMs: pauses.reduce((sum, ms) => sum + ms, 0),
        maxMs: Math.max(0, ...pauses),
      };
    }),
    loadBefore,
    loadAfter: os.loadavg(),
    memory: process.memoryUsage(),
    payloadSha256: hash("sha256", JSON.stringify(result)),
  }),
);
