/**
 * Anthropic request construction with frozen history, a changing tail, tools and hooks.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/anthropic-request-construction.ts
 *   --messages 40 --iterations 2000 [--allocation] [--baseline-dir /absolute/source-overlay]
 * Repeat with --messages 150. --mode build omits serialization; --mode serialize
 * reuses one prepared body. Full mode changes the mutable tail and max_tokens each call.
 * --retained measures real projection/fragment ownership and release (use --expose-gc).
 * All non-build modes consume contiguous bytes, matching the guarded Blob body path.
 * scenarioHashes must match across revisions: tool turns, moved cache boundaries, hook edits.
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
import { setImmediate } from "node:timers/promises";
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
    retained: { type: "boolean", default: false },
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
const { freezeJsonSnapshot, isDeeplyFrozenPlainData, isPlainData } =
  await import("../../src/shared/immutable-data.js");
configureAiTransportHost({
  transformTransportMessages,
  immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData, isPlainData },
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
messages.slice(0, -1).forEach(freezeJsonSnapshot);
let context: Context | undefined = {
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
const serialize = values["baseline-dir"]
  ? undefined
  : (await import("../../packages/ai/src/transports/anthropic-request-body.js"))
      .serializeAnthropicRequestBody;
type Prepared = Awaited<ReturnType<typeof prepareAnthropicRequest>>;
async function build(requestOptions = options): Promise<Prepared> {
  assert(context);
  const built = await buildAnthropicRequest(
    model,
    context,
    requestOptions,
    "transport",
    false,
    false,
  );
  return prepareAnthropicRequest(built.params, model, requestOptions, "");
}
function changeTail(index: number): void {
  const tail = messages.at(-1)!;
  assert(tail.role === "user" || tail.role === "toolResult");
  tail.content = [{ type: "text", text: `Changing tail ${index}: café 🦞` }];
  options.maxTokens = 1000 + (index % 7);
}
const encoder = new TextEncoder();
async function encode(prepared: Prepared): Promise<Uint8Array<ArrayBuffer>> {
  const body = { ...prepared.params, stream: true as const };
  const encoded = serialize ? serialize(body, prepared.messageSources) : JSON.stringify(body);
  // This is the exact contiguous immutable-body copy performed by the fetch guard.
  return encoded instanceof Blob
    ? new Uint8Array(await encoded.arrayBuffer())
    : encoder.encode(encoded);
}
async function collect(): Promise<void> {
  for (let index = 0; index < 3; index++) {
    await setImmediate();
    globalThis.gc?.();
  }
}
if (values.retained) {
  assert(globalThis.gc, "--retained requires --expose-gc");
  assert(!values.allocation, "--retained and --allocation are separate passes");
  changeTail(0);
  const held: { prepared?: Prepared; bytes?: Uint8Array<ArrayBuffer> } = {
    prepared: await build(),
  };
  assert(held.prepared);
  // Conversion owners are already warm: the next delta is fragment retention.
  await collect();
  const beforeFragments = process.memoryUsage();
  held.bytes = await encode(held.prepared);
  assert.equal(
    hash("sha256", held.bytes),
    hash("sha256", JSON.stringify({ ...held.prepared.params, stream: true })),
  );
  const wireBytes = held.bytes.byteLength;
  const wireSha256 = hash("sha256", held.bytes);
  delete held.bytes;
  await collect();
  const withFragments = process.memoryUsage();
  const sourceRefs = messages.slice(0, -1).map((message) => new WeakRef(message));
  const projectionRefs = (held.prepared.messageSources ?? held.prepared.params.messages).map(
    (message) => {
      assert(typeof message === "object" && message !== null);
      return new WeakRef(message);
    },
  );
  delete held.prepared;
  context = undefined;
  messages.length = 0;
  await collect();
  const afterHistoryReleased = process.memoryUsage();
  console.log(
    JSON.stringify({
      messages: messageCount,
      retained: true,
      baseline: Boolean(values["baseline-dir"]),
      wireBytes,
      wireSha256,
      beforeFragments,
      withFragments,
      afterHistoryReleased,
      sourceKeys: sourceRefs.length,
      sourceKeysCollected: sourceRefs.filter((reference) => reference.deref() === undefined).length,
      projectionKeys: projectionRefs.length,
      projectionKeysCollected: projectionRefs.filter((reference) => reference.deref() === undefined)
        .length,
      hostLoad: loadavg(),
    }),
  );
  process.exit(0);
}
async function scenarioProof() {
  assert(context);
  changeTail(0);
  const scenarios: Array<{ name: string; bytes: number; sha256: string }> = [];
  const record = async (name: string, requestOptions = options) => {
    const prepared = await build(requestOptions);
    const actual = await encode(prepared);
    const expected = JSON.stringify({ ...prepared.params, stream: true });
    assert.equal(hash("sha256", actual), hash("sha256", expected), name);
    scenarios.push({ name, bytes: actual.byteLength, sha256: hash("sha256", actual) });
  };
  await record("initial");
  const initialLength = messages.length;
  messages.push(
    freezeJsonSnapshot({
      role: "assistant",
      timestamp: initialLength,
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
        { type: "toolCall", id: "boundary_call", name: "lookup", arguments: { query: "next" } },
      ],
    }),
  );
  await record("tool_call");
  messages.push(
    freezeJsonSnapshot({
      role: "toolResult",
      timestamp: initialLength + 1,
      toolCallId: "boundary_call",
      toolName: "lookup",
      isError: false,
      content: [{ type: "text", text: "Result 🦞" }],
    }),
  );
  await record("tool_result");
  messages.push({ role: "user", timestamp: initialLength + 2, content: "Move checkpoint" });
  await record("cache_boundary_moved");
  await record("hook_edit", {
    ...options,
    onPayload(payload) {
      assert(payload && typeof payload === "object" && "messages" in payload);
      const history = payload.messages;
      assert(Array.isArray(history));
      const first = history[0];
      assert(first && typeof first === "object");
      first.content = "Hook changed frozen history 🦞";
    },
  });
  await record("hook_replace", {
    ...options,
    onPayload: () => ({
      model: model.id,
      messages: [{ role: "user", content: "Hook replacement" }],
      max_tokens: 123,
      stream: true,
    }),
  });
  messages.length = initialLength;
  return scenarios;
}
const scenarioHashes = await scenarioProof();
changeTail(0);
const prepared = await build();
let lastPrepared = prepared;
let last: Uint8Array<ArrayBuffer> | undefined;
async function run() {
  for (let index = 0; index < iterations; index++) {
    if (values.mode !== "serialize") {
      changeTail(index);
    }
    lastPrepared = values.mode === "serialize" ? prepared : await build();
    last = values.mode === "build" ? undefined : await encode(lastPrepared);
  }
}
async function verifyLast() {
  const expectedWire = JSON.stringify({ ...lastPrepared.params, stream: true });
  if (last) {
    assert.equal(hash("sha256", last), hash("sha256", expectedWire));
  }
  return expectedWire;
}
await run();
await verifyLast();
await collect();
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
const expectedWire = await verifyLast();
const memoryBeforeFinalGc = process.memoryUsage();
globalThis.gc?.();
console.log(
  JSON.stringify({
    messages: messageCount,
    mode: values.mode,
    allocation: values.allocation,
    iterations,
    scenarioHashes,
    contiguousOutputBytesPerRequest: values.mode === "build" ? 0 : last?.byteLength,
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
