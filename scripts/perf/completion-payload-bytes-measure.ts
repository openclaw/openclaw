/**
 * Prepared Anthropic simple completion with 40 messages and diagnostic byte capture.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/completion-payload-bytes-measure.ts
 *   --mode timing|allocation --iterations 2000 [--baseline-dir /absolute/source-overlay]
 * Run alternating base/candidate arms; compare untraced CPU separately from allocation.
 * Acceptance: identical wire bytes, one request serialization, lower B/request and CPU/request.
 * This isolates request construction/diagnostics; it does not measure Gateway latency.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
    "baseline-dir": { type: "string" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 2000,
  min: 1,
  label: "iterations",
});
if (values["baseline-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["baseline-dir"]);
  await import("./worker-retained-heap-preload.js");
}
const { configureAiTransportHost, getAiTransportHost } =
  await import("../../packages/ai/src/host.js");
await import("../../src/agents/ai-transport-runtime-host.js");
const { completeWithPreparedSimpleCompletionModel } =
  await import("../../src/agents/simple-completion-execution.js");
const {
  onTrustedInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} = await import("../../src/infra/diagnostic-events.js");
const { makeProviderModelFixture } =
  await import("../../src/agents/test-helpers/provider-model-fixture.js");
const model = makeProviderModelFixture({
  id: "synthetic-model",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://provider.invalid",
});
const context = {
  messages: Array.from({ length: 40 }, (_, index) => ({
    role: "user" as const,
    content: `Message ${index}: ` + 'synthetic output " \\ \n café 🦞 '.repeat(256),
    timestamp: index,
  })),
};
const response =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","usage":{"input_tokens":40,"output_tokens":0}}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';
let wire = "";
let reportedBytes = 0;
let requests = 0;
let completions = 0;
const host = getAiTransportHost();
configureAiTransportHost({
  ...host,
  buildModelFetch: () => async (_url, init) => {
    assert(typeof init?.body === "string");
    wire = init.body;
    requests++;
    return new Response(response, { headers: { "content-type": "text/event-stream" } });
  },
});
setDiagnosticsEnabledForProcess(true);
const stop = onTrustedInternalDiagnosticEvent(
  (event) => {
    if (event.type === "model.call.completed") {
      reportedBytes = event.requestPayloadBytes ?? 0;
      completions++;
    }
  },
  { include: ["model.call.completed"] },
);
async function run(count: number) {
  for (let i = 0; i < count; i++) {
    const result = await completeWithPreparedSimpleCompletionModel({
      model,
      context,
      cfg: { plugins: { enabled: false } },
      auth: { apiKey: "synthetic-key", mode: "api-key", source: "benchmark" },
    });
    assert.equal(result.stopReason, "stop");
    assert.equal(result.usage.output, 1);
    await waitForDiagnosticEventsDrained();
  }
}
await run(100);
const expectedWire = wire;
assert.equal(reportedBytes, Buffer.byteLength(wire));
requests = completions = 0;
globalThis.gc?.();
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const gc = new GCProfiler();
gc.start();
const hostLoad = loadavg();
const start = performance.now();
const before = process.threadCpuUsage();
await run(iterations);
const cpu = process.threadCpuUsage(before);
const wallMs = performance.now() - start;
const collections = gc.stop()?.statistics ?? [];
let sampledBytes: number | undefined;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  inspector.disconnect();
}
assert.equal(requests, iterations);
assert.equal(completions, iterations);
assert.equal(wire, expectedWire);
assert.equal(reportedBytes, Buffer.byteLength(wire));
console.log(
  JSON.stringify({
    mode: values.mode,
    iterations,
    wireBytes: reportedBytes,
    wireSha256: hash("sha256", wire),
    hostLoad,
    wallMs,
    cpuUsPerRequest: (cpu.user + cpu.system) / iterations,
    allocationBytesPerRequest: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    gcMs: collections.reduce((sum, entry) => sum + entry.cost / 1000, 0),
    gcMaxMs: Math.max(0, ...collections.map((entry) => entry.cost / 1000)),
    gcCount: collections.length,
    gcByKind: [...new Set(collections.map((entry) => entry.gcType))].map((kind) => {
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
    memory: process.memoryUsage(),
  }),
);
stop();
configureAiTransportHost(host);
