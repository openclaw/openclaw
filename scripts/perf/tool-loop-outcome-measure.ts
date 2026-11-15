/**
 * Measures recordToolCallOutcome CPU and sampled allocation, not Gateway throughput.
 * Run in each revision, alternating base/candidate order for five pairs:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-loop-outcome-measure.ts
 *   [--owner src/agents/tool-loop-detection.ts] [--bytes 102400] [--iterations 200]
 *   [--shape nested|leaf|wide] [--allocations]
 * Inputs are prepared before warmup; allocation profiling is a separate pass.
 * Compare 1 KiB controls and 100 KiB/1 MiB/5 MiB outcomes, including changed tails.
 */
import assert from "node:assert/strict";
import inspector from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SessionState } from "../../src/logging/diagnostic-session-state.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/agents/tool-loop-detection.ts" },
    bytes: { type: "string", default: "102400" },
    iterations: { type: "string", default: "200" },
    shape: { type: "string", default: "nested" },
    allocations: { type: "boolean", default: false },
  },
});
const bytes = Number(values.bytes);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(bytes) && bytes > 0);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["nested", "leaf", "wide"].includes(values.shape));
const { recordToolCallOutcome } = (await import(
  pathToFileURL(path.resolve(values.owner)).href
)) as typeof import("../../src/agents/tool-loop-detection.js");
const text = "Synthetic tool output 🦞\n".repeat(Math.ceil(bytes / 28));
const details =
  values.shape === "leaf"
    ? { output: text }
    : values.shape === "wide"
      ? Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`key${index}`, index]))
      : { results: [{ output: { rows: [{ payload: text }], status: "failed" } }] };
const results = ["same", "changed"].map((tail) => ({
  content: [{ type: "text", text: "Synthetic tool response" }],
  details: { ...details, tail },
}));
const state: SessionState = { lastActivity: 0, state: "processing", queueDepth: 0 };
const invoke = (index: number) =>
  recordToolCallOutcome(state, {
    toolName: "synthetic_tool",
    toolParams: { query: "synthetic" },
    result: results[index % 2],
  })?.resultHash;
const hashes = [invoke(0), invoke(1)];
assert(hashes[0] && hashes[1] && hashes[0] !== hashes[1]);
for (let index = 0; index < 30; index++) {
  assert.equal(invoke(index), hashes[index % 2]);
}
global.gc?.();
const session = new inspector.Session();
if (values.allocations) {
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpuStart = process.cpuUsage();
const started = performance.now();
for (let index = 0; index < iterations; index++) {
  invoke(index);
}
const wallMs = performance.now() - started;
const cpu = process.cpuUsage(cpuStart);
let sampledBytes: number | undefined;
if (values.allocations) {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  const sum = (node: inspector.HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  session.disconnect();
}
console.log(
  JSON.stringify({
    ...values,
    iterations,
    inputBytes: Buffer.byteLength(JSON.stringify(results[0])),
    hostLoad,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    sampledBytes,
    hashes,
    ...process.memoryUsage(),
  }),
);
