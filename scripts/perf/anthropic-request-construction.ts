/**
 * Frozen Anthropic request construction with tools, cache control and a payload hook.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/anthropic-request-construction.ts
 *   --messages 40 --iterations 2000 [--allocation] [--baseline-dir /absolute/source-overlay]
 * Repeat with --messages 150. --mode build omits serialization; --mode serialize
 * reuses one prepared body. The default full mode runs both production owners.
 * Run five alternating base/candidate arms per workload and instrumentation mode.
 * Acceptance: identical wireSha256, lower allocation/CPU per request, no controlled
 * material GC regression. Gate CPU/GC on untraced passes, allocation separately.
 * This measures request preparation, not fetch, provider calls or Gateway latency.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import type { AnthropicOptions } from "../../packages/ai/src/provider-options.js";
import type { Context, Model } from "../../packages/llm-core/src/types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    messages: { type: "string", default: "40" },
    mode: { type: "string", default: "full" },
    iterations: { type: "string", default: "2000" },
    allocation: { type: "boolean", default: false },
    "baseline-dir": { type: "string" },
  },
});
assert(values.messages === "40" || values.messages === "150", "--messages must be 40 or 150");
assert(
  values.mode === "full" || values.mode === "build" || values.mode === "serialize",
  "--mode must be full, build or serialize",
);
const messageCount = Number(values.messages);
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
const { configureAiTransportHost } = await import("../../packages/ai/src/host.js");
const { buildAnthropicRequest, prepareAnthropicRequest } =
  await import("../../packages/ai/src/transports/anthropic-messages.js");
const { transformTransportMessages } =
  await import("../../src/agents/transport-message-transform.js");
const { freezeJsonSnapshot, isDeeplyFrozenPlainData } =
  await import("../../src/shared/immutable-data.js");
configureAiTransportHost({
  transformTransportMessages,
  immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
});
const model: Model<"anthropic-messages"> = {
  id: "claude-sonnet-4-5",
  name: "Synthetic",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  contextWindow: 200000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const messages: Context["messages"] = [];
for (let index = 0; index < messageCount; index++) {
  const turn = Math.floor(index / 3);
  const text = `Synthetic ${index}: ` + 'line "quoted" \\ café 🦞\n'.repeat(160);
  if (index % 3 === 0) {
    messages.push({ role: "user", timestamp: index, content: [{ type: "text", text }] });
  } else if (index % 3 === 1) {
    messages.push({
      role: "assistant",
      timestamp: index,
      provider: model.provider,
      api: model.api,
      model: model.id,
      stopReason: "toolUse",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [
        { type: "text", text: "Checking" },
        { type: "toolCall", id: `call_${turn}`, name: "lookup", arguments: { query: text } },
      ],
    });
  } else {
    messages.push({
      role: "toolResult",
      timestamp: index,
      toolCallId: `call_${turn}`,
      toolName: "lookup",
      isError: false,
      content: [{ type: "text", text }],
    });
  }
}
messages.forEach(freezeJsonSnapshot);
const context: Context = {
  systemPrompt: "Synthetic system block. ".repeat(100),
  messages,
  tools: [
    {
      name: "lookup",
      description: "Look up a synthetic value",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
};
const options: AnthropicOptions = {
  cacheRetention: "long",
  thinkingEnabled: true,
  onPayload: () => undefined,
};
async function build() {
  const built = await buildAnthropicRequest(model, context, options, "transport", false, false);
  return (await prepareAnthropicRequest(built.params, model, options, "")).params;
}
const prepared = await build();
const expectedWire = JSON.stringify(prepared);
let last: typeof prepared | string = prepared;
async function run() {
  for (let index = 0; index < iterations; index++) {
    const body = values.mode === "serialize" ? prepared : await build();
    last = values.mode === "build" ? body : JSON.stringify({ ...body, stream: true });
  }
}
await run();
assert.equal(typeof last === "string" ? last : JSON.stringify(last), expectedWire);
globalThis.gc?.();
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const gc = new GCProfiler();
gc.start();
const hostLoadBefore = loadavg();
const before = process.threadCpuUsage();
const start = performance.now();
await run();
const cpu = process.threadCpuUsage(before);
const elapsedMs = performance.now() - start;
const collections = gc.stop()?.statistics ?? [];
let allocationBytesPerRequest: number | undefined;
let sites: Array<{ name: string; bytesPerRequest: number }> | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const totals = new Map<string, number>();
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number => {
    const name = `${node.callFrame.functionName}@${node.callFrame.url.split("/").at(-1)}`;
    totals.set(name, (totals.get(name) ?? 0) + node.selfSize);
    return node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  };
  allocationBytesPerRequest = sum(profile.head) / iterations;
  sites = [...totals]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, bytes]) => ({ name, bytesPerRequest: bytes / iterations }));
  inspector.disconnect();
}
assert.equal(typeof last === "string" ? last : JSON.stringify(last), expectedWire);
const memoryBeforeFinalGc = process.memoryUsage();
globalThis.gc?.();
console.log(
  JSON.stringify({
    messages: messageCount,
    mode: values.mode,
    allocation: values.allocation,
    iterations,
    wireBytes: Buffer.byteLength(expectedWire),
    wireSha256: hash("sha256", expectedWire),
    mainThreadCpuUsPerRequest: (cpu.user + cpu.system) / iterations,
    allocationBytesPerRequest,
    elapsedMs,
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
    memoryBeforeFinalGc,
    memory: process.memoryUsage(),
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    sites,
  }),
);
