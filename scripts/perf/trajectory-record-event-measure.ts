/**
 * Owner-only synthetic recordEvent measurement; no Gateway or database writes.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/trajectory-record-event-measure.ts
 *   --mode timing --iterations 2000
 * Repeat with --mode allocation, alternating five base/candidate process samples.
 * Baseline: OPENCLAW_BENCH_BASELINE_DIR=/absolute/source-overlay plus
 * --import ./scripts/perf/worker-retained-heap-preload.ts after the TSX preload.
 * The sink alone is replaced; runtime limiting, projection and serialization are real.
 * Compare outputHash before metrics. Acceptance: unchanged captured bytes, zero
 * omitted-replay reads, reduced allocation/CPU. Untraced timing owns CPU/GC evidence.
 * Context models 60 messages and 40 tools; tool lifecycle is a no-replay control.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
  },
});
assert(global.gc, "Use --expose-gc");
assert(["timing", "allocation"].includes(values.mode));
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 2000,
  min: 1,
  label: "--iterations",
});
assert(iterations <= 100000);
const sinkUrl = `data:text/javascript,${encodeURIComponent(`
let lastLine;
export const readLine = () => lastLine;
export const createSqliteTrajectoryRuntimeSink = async () => ({
  write: (_event, line) => { lastLine = line; },
  flush: async () => {},
  describeFlushState: () => undefined,
});`)}`;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier.endsWith("/runtime-store-writer.js") ||
      specifier === "./runtime-store-writer.js"
      ? { url: sinkUrl, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const sink: { readLine(): string } = await import(sinkUrl);
const { createTrajectoryRuntimeRecorder } = await import("../../src/trajectory/runtime.js");
hook.deregister();
const recorder = await createTrajectoryRuntimeRecorder({
  sessionId: "synthetic",
  env: { OPENCLAW_TRAJECTORY: "1" },
});
assert(recorder);
const replay = {
  v: 1,
  type: "anthropic-compaction",
  data: "synthetic opaque state ".repeat(2000),
  provider: "synthetic",
  api: "synthetic",
  model: "mock",
  sessionHash: "synthetic",
};
const messages = Array.from({ length: 60 }, (_, index) => ({
  role: index % 2 ? "assistant" : "user",
  ...(index % 2 ? { providerReplay: replay } : {}),
  content: [{ type: "text", text: `Message ${index}. ${"Synthetic context. ".repeat(16)}` }],
}));
const context = {
  systemPrompt: "Synthetic system instruction. ".repeat(100),
  messages,
  tools: Array.from({ length: 40 }, (_, index) => ({
    name: `tool_${index}`,
    parameters: { type: "object", properties: { query: { type: "string" } } },
  })),
};
const call = { name: "synthetic_tool", toolCallId: "call-1", args: { query: "inspect" } };
const result = {
  name: "synthetic_tool",
  toolCallId: "call-1",
  success: true,
  result: { content: [{ type: "text", text: "Synthetic result. ".repeat(64) }] },
};
const golden = [];
const scenarios = [];
for (const [name, capture] of [
  ["attempt-context", () => recorder.recordEvent("context.compiled", context)],
  [
    "tool-lifecycle",
    () => {
      recorder.recordEvent("tool.call", call);
      recorder.recordEvent("tool.result", result);
    },
  ],
] as const) {
  capture();
  const captured = JSON.parse(sink.readLine());
  delete captured.ts;
  delete captured.seq;
  delete captured.sourceSeq;
  assert(!JSON.stringify(captured).includes("providerReplay"));
  golden.push(captured);
  for (let index = 0; index < 100; index++) {
    capture();
  }
  global.gc();
  await nextTurn();
  const inspector = new Session();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 8192,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const collections: Array<{ kind: number; start: number; duration: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const event of list.getEntries()) {
      const detail = (event as import("node:perf_hooks").PerformanceNodeEntry).detail;
      collections.push({ kind: detail.kind, start: event.startTime, duration: event.duration });
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const before = process.memoryUsage();
  const hostLoad = loadavg();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    capture();
  }
  const end = performance.now();
  const elapsedCpu = process.threadCpuUsage(cpu);
  const after = process.memoryUsage();
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  let allocation;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocation = {
      bytesPerOperation: profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations,
      samples: profile.samples.length,
    };
    inspector.disconnect();
  }
  const gc = collections.filter((event) => event.start >= start && event.start < end);
  scenarios.push({
    name,
    iterations,
    cpuUsPerOperation: (elapsedCpu.user + elapsedCpu.system) / iterations,
    wallMs: end - start,
    allocation,
    gc: [...new Set(gc.map((event) => event.kind))].map((kind) => {
      const pauses = gc.filter((event) => event.kind === kind).map((event) => event.duration);
      return {
        kind,
        count: pauses.length,
        totalMs: pauses.reduce((a, b) => a + b, 0),
        maxMs: Math.max(...pauses),
      };
    }),
    hostLoad,
    before,
    after,
  });
}
console.log(
  JSON.stringify({
    mode: values.mode,
    node: process.version,
    outputHash: createHash("sha256").update(JSON.stringify(golden)).digest("hex"),
    scenarios,
  }),
);
