/**
 * Summary-input owner benchmark, with no provider/network or transcript writes.
 * Run from a prepared checkout: node --expose-gc --import ./scripts/tsx.mjs
 * scripts/perf/compaction-serialization-measure.mjs [--module <owner-module>]
 * [--mode timing|allocation] [--turns 64] [--argument-chars 2048]
 * [--result-chars 32768] [--iterations 2000]. Use identical args for base/head.
 * For a >128 MiB history use --turns 2048 --argument-chars 32768
 * --result-chars 32768 --iterations 30. Compare outputHash before timings.
 * Timing runs are untraced; allocation runs include collected objects. GC tails
 * with <1,000 samples are context only. This does not measure Gateway latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    mode: { type: "string", default: "timing" },
    turns: { type: "string", default: "64" },
    "argument-chars": { type: "string", default: "2048" },
    "result-chars": { type: "string", default: "32768" },
    iterations: { type: "string", default: "2000" },
  },
});
const integer = (key) => {
  const value = Number(values[key]);
  assert.ok(Number.isSafeInteger(value) && value > 0, `Invalid --${key}`);
  return value;
};
const turns = integer("turns");
const argumentChars = integer("argument-chars");
const resultChars = integer("result-chars");
const iterations = integer("iterations");
assert.ok(["timing", "allocation"].includes(values.mode));
assert.ok(global.gc, "Run with --expose-gc");
const { serializeConversationWithinBudget } = await import(
  values.module
    ? pathToFileURL(values.module).href
    : "../../packages/agent-core/src/harness/compaction/utils.ts"
);
const messages = [];
for (let turn = 0; turn < turns; turn++) {
  messages.push({ role: "user", content: `Synthetic edit ${turn}`, timestamp: turn });
  messages.push({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `call-${turn}`,
        name: "write",
        arguments: {
          path: `src/example-${turn}.ts`,
          content: "synthetic line\n".repeat(Math.ceil(argumentChars / 15)).slice(0, argumentChars),
        },
      },
    ],
    timestamp: turn,
  });
  messages.push({
    role: "toolResult",
    toolCallId: `call-${turn}`,
    toolName: "write",
    content: [
      {
        type: "text",
        text: "synthetic result ".repeat(Math.ceil(resultChars / 17)).slice(0, resultChars),
      },
    ],
    isError: false,
    timestamp: turn,
  });
}
const fixtureBytes = Buffer.byteLength(JSON.stringify(messages));
const run = () => serializeConversationWithinBudget(messages, 160_000);
const expected = run();
const outputHash = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
for (let warmup = 0; warmup < 10; warmup++) {
  run();
}
global.gc();
await nextTurn();
const gc = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.push({ at: entry.startTime, ms: entry.duration, kind: entry.detail.kind });
  }
});
observer.observe({ entryTypes: ["gc"] });
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const durations = [];
const beforeCpu = process.threadCpuUsage();
const started = performance.now();
let checksum = 0;
for (let iteration = 0; iteration < iterations; iteration++) {
  const start = performance.now();
  const result = run();
  durations.push(performance.now() - start);
  assert.equal(result.text.length, expected.text.length);
  checksum += result.text.length;
  await nextTurn();
}
const ended = performance.now();
const cpu = process.threadCpuUsage(beforeCpu);
await nextTurn();
await nextTurn();
let allocatedBytes;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const bytes = (node) =>
    node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
  allocatedBytes = bytes(profile.head);
  inspector.disconnect();
}
observer.disconnect();
const byKind = {};
for (const entry of gc.filter((sample) => sample.at >= started && sample.at < ended)) {
  const metric = (byKind[entry.kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
  metric.count++;
  metric.totalMs += entry.ms;
  metric.maxMs = Math.max(metric.maxMs, entry.ms);
}
durations.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    mode: values.mode,
    turns,
    argumentChars,
    resultChars,
    iterations,
    fixtureBytes,
    outputHash,
    checksum,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    wallMs: ended - started,
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    p50Ms: durations[Math.ceil(iterations * 0.5) - 1],
    p95Ms: durations[Math.ceil(iterations * 0.95) - 1],
    allocatedBytes,
    allocatedBytesPerOperation: allocatedBytes / iterations,
    gc: byKind,
    memory: process.memoryUsage(),
  }),
);
