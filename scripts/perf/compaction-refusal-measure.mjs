/**
 * Synthetic summary-refusal owner benchmark; no network, disk history, or credentials.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/compaction-refusal-measure.mjs
 *   --root <checkout> --expect cancelled|trimmed --mode timing|allocation --iterations 5
 * Compare fresh processes in A/A and alternating A/B order. Measures the real safeguard
 * and summary serializer with a fixed refusal stream; persistence is covered by tests.
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
    expect: { type: "string", default: "trimmed" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "5" },
  },
});
assert.ok(global.gc, "Use --expose-gc");
assert.ok(["trimmed", "cancelled"].includes(values.expect));
assert.ok(["timing", "allocation"].includes(values.mode));
const iterations = Number(values.iterations);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
const source = (file) => import(pathToFileURL(path.resolve(values.root, file)).href);
const { default: safeguard } = await source("src/agents/agent-hooks/compaction-safeguard.ts");
const { prepareCompaction, estimateTokens } = await source(
  "packages/agent-core/src/harness/compaction/compaction.ts",
);
const { buildSessionContext } = await source("packages/agent-core/src/harness/session/session.ts");
const { AssistantMessageEventStream } = await source("packages/llm-core/src/utils/event-stream.ts");
const { consumeCompactionSafeguardCancellation } = await source(
  "src/agents/agent-hooks/compaction-safeguard-runtime.ts",
);
const model = {
  id: "synthetic-summary",
  name: "Synthetic summary",
  provider: "fixture",
  api: "anthropic-messages",
  baseUrl: "http://127.0.0.1:1",
  contextWindow: 1_000_000,
  maxTokens: 4096,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
  input: 1,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const entries = [];
const append = (message) =>
  entries.push({
    type: "message",
    id: `entry-${entries.length}`,
    parentId: entries.at(-1)?.id ?? null,
    timestamp: new Date(entries.length).toISOString(),
    message,
  });
for (let turn = 0; turn < 51; turn++) {
  append({
    role: "user",
    content: `Synthetic task ${turn}: preserve the current work.`,
    timestamp: turn,
  });
  const input = entries.reduce((sum, entry) => sum + estimateTokens(entry.message), 0);
  append({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `call-${turn}`,
        name: "read",
        arguments: { path: `synthetic-${turn}.txt` },
      },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "toolUse",
    usage: { ...usage, input, totalTokens: input },
    timestamp: turn,
  });
  append({
    role: "toolResult",
    toolCallId: `call-${turn}`,
    toolName: "read",
    content: [{ type: "text", text: "Synthetic relayed code and result.\n".repeat(1800) }],
    isError: false,
    timestamp: turn,
  });
}
const prepared = prepareCompaction(entries, {
  enabled: true,
  reserveTokens: 20_000,
  keepRecentTokens: 8_000,
});
assert.ok(prepared.ok && prepared.value);
const preparation = prepared.value;
assert.ok(preparation.tokensBefore > 750_000);
let handler;
safeguard({
  on: (name, callback) => {
    if (name === "session_before_compact") {
      handler = callback;
    }
  },
});
assert.ok(handler);
let requests = 0;
const streamFn = () => {
  requests++;
  const stream = new AssistantMessageEventStream();
  const error = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    timestamp: 1,
    stopReason: "error",
    errorMessage: "Synthetic summarizer refusal",
    diagnostics: [
      { type: "provider_refusal", timestamp: 1, details: { category: "reasoning_extraction" } },
    ],
  };
  stream.push({ type: "error", reason: "error", error });
  stream.end(error);
  return stream;
};
const sessionManager = { getBranch: () => entries };
const context = {
  model,
  sessionManager,
  modelRegistry: {
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-placeholder" }),
  },
};
const run = async () => {
  const result = await handler(
    { preparation, signal: new AbortController().signal, streamFn },
    context,
  );
  if (values.expect === "cancelled") {
    assert.equal(result.cancel, true);
    assert.match(consumeCompactionSafeguardCancellation(sessionManager).reason, /refusal/);
    return preparation.tokensBefore;
  }
  assert.equal(result.compaction.details.summaryRefused, true);
  const retained = buildSessionContext([
    ...entries,
    {
      ...result.compaction,
      id: "boundary",
      parentId: entries.at(-1).id,
      timestamp: new Date().toISOString(),
      type: "compaction",
    },
  ]).messages;
  const tokens = retained.reduce((sum, message) => sum + estimateTokens(message), 0);
  assert.ok(tokens < 750_000);
  return tokens;
};
await run();
requests = 0;
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
let tokensAfter;
for (let index = 0; index < iterations; index++) {
  const start = performance.now();
  tokensAfter = await run();
  samples.push(performance.now() - start);
}
const cpu = process.threadCpuUsage(cpuStart);
let allocationBytes;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const bytes = (node) =>
    node.selfSize + node.children.reduce((total, child) => total + bytes(child), 0);
  allocationBytes = bytes(profile.head);
  inspector.disconnect();
}
samples.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    expectedOutcome: values.expect,
    mode: values.mode,
    iterations,
    hostLoad,
    fixtureMessages: entries.length,
    fixtureBytes: Buffer.byteLength(JSON.stringify(entries)),
    tokensBefore: preparation.tokensBefore,
    tokensAfter,
    requestsPerOperation: requests / iterations,
    p50Ms: samples[Math.ceil(iterations * 0.5) - 1],
    p95Ms: samples[Math.ceil(iterations * 0.95) - 1],
    cpuMsPerOperation: (cpu.user + cpu.system) / 1000 / iterations,
    allocatedBytesPerOperation: allocationBytes / iterations,
  }),
);
