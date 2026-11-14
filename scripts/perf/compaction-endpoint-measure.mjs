/**
 * Endpoint admission only: 768 synthetic messages, real serializer/transport, fixed HTTP 400.
 * No network or credentials. Client reduction/persistence is covered by compact.small-context.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/compaction-endpoint-measure.mjs
 *   --root <checkout> --expect sent|skipped --mode timing|allocation --iterations 5
 * Run fresh A/A controls and serial interleaved A/B processes; do not infer live latency.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: process.cwd() },
    expect: { type: "string", default: "skipped" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "5" },
  },
});
assert.ok(global.gc, "Use --expose-gc");
assert.ok(["sent", "skipped"].includes(values.expect));
assert.ok(["timing", "allocation"].includes(values.mode));
const iterations = Number(values.iterations);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
const source = (file) => import(pathToFileURL(path.resolve(values.root, file)).href);
const { attemptServerEndpointCompaction } = await source(
  "src/agents/embedded-agent-runner/server-endpoint-compaction.ts",
);
const { estimateLlmBoundaryTokenPressure } = await source(
  "src/agents/embedded-agent-runner/run/preemptive-compaction.ts",
);
const { configureAiTransportHost } = await import("@openclaw/ai");
const { createOpenAIResponsesTransportStreamFn } = await import("@openclaw/ai/transports");
const model = {
  id: "gpt-6.1-sol",
  name: "gpt-6.1-sol",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://synthetic.invalid/v1",
  contextWindow: 922_000,
  maxTokens: 128_000,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const messages = Array.from({ length: 768 }, (_, index) => {
  const text = `Synthetic record ${index}. ${"Retain the test task and its result. ".repeat(112)}`;
  return index % 2 === 0
    ? { role: "user", content: text, timestamp: index }
    : {
        role: "assistant",
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        timestamp: index,
        stopReason: "stop",
      };
});
const context = { systemPrompt: "Summarize synthetic history.", messages };
const inputTokens = estimateLlmBoundaryTokenPressure({ ...context, prompt: "" });
assert.ok(inputTokens > model.contextWindow);
let requests = 0;
let requestBytes = 0;
configureAiTransportHost({
  buildModelFetch: () => async (_input, init) => {
    assert.match(String(_input.url ?? _input), /\/responses\/compact$/);
    requests++;
    requestBytes += Buffer.byteLength(init.body);
    return new Response(
      JSON.stringify({
        error: {
          message: "Your input exceeds the context window of this model.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  },
});
const params = {
  // The mid-turn precheck supplies this already computed fact in production.
  estimatedInputTokens: inputTokens,
  trigger: "budget",
  model,
  context,
  extraParams: { responsesCompactEndpoint: true },
  streamFn: createOpenAIResponsesTransportStreamFn(),
  sessionManager: { getBranch: () => [{ type: "message", id: "owner", message: messages.at(-1) }] },
  requestOptions: { apiKey: "synthetic-placeholder", timeoutMs: 1_000 },
};
const run = async () => {
  const before = requests;
  assert.equal(await attemptServerEndpointCompaction(params), undefined);
  assert.equal(requests - before, values.expect === "sent" ? 1 : 0);
};
await run();
requests = requestBytes = 0;
global.gc();
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpuStart = process.threadCpuUsage();
const samples = [];
for (let index = 0; index < iterations; index++) {
  const start = performance.now();
  await run();
  samples.push(performance.now() - start);
}
const cpu = process.threadCpuUsage(cpuStart);
let allocatedBytes;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const bytes = (node) =>
    node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
  allocatedBytes = bytes(profile.head);
  inspector.disconnect();
}
samples.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    mode: values.mode,
    iterations,
    hostLoad,
    fixtureMessages: messages.length,
    fixtureBytes: Buffer.byteLength(JSON.stringify(messages)),
    inputTokens,
    requestsPerOperation: requests / iterations,
    requestBytesPerOperation: requestBytes / iterations,
    p50Ms: samples[Math.ceil(iterations * 0.5) - 1],
    p95Ms: samples[Math.ceil(iterations * 0.95) - 1],
    cpuMsPerOperation: (cpu.user + cpu.system) / 1000 / iterations,
    allocatedBytesPerOperation: allocatedBytes / iterations,
  }),
);
