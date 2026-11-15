/**
 * Anthropic request construction with frozen history, a changing tail, tools and hooks.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/anthropic-request-construction.ts
 *   --messages 40 --iterations 2000 [--allocation] [--baseline-dir /absolute/source-overlay]
 * Repeat with --messages 150. --mode build omits serialization; --mode serialize
 * reuses one prepared body. Full mode changes the mutable tail and max_tokens each call.
 * --retained measures real projection/fragment ownership and release (use --expose-gc).
 * --images uses 48 messages with 12 frozen 64 KiB inline images (user + tool results),
 * the real host image normalizer and existing serialization on both revisions.
 * --mode system isolates system normalization; use --prepared-system and --iterations 20000.
 * --prepared-system carries a session-owned 64 KiB prompt revision through request construction.
 * All non-build modes consume contiguous bytes, flattening older Blob bodies like guarded fetch.
 * scenarioHashes must match across revisions: tool turns, moved cache boundaries, hook edits.
 * Run five alternating base/candidate arms per workload and instrumentation mode.
 * --restored replays 199 restored messages with 40 KiB tool results through attempt
 * preparation and the real transport, appending a tool turn per iteration (use 20).
 * In restored mode --baseline-dir overlays the owner, including the real serializer.
 * Acceptance: identical wireSha256 and lower warm CPU/allocation. For restored mode,
 * the one-time preparation + first-request CPU increase must be less than one warm
 * request CPU saving (or within control noise). Report GC/tails separately; p95Ms
 * is the floor(n * .95) order statistic, hence the maximum with 20 iterations.
 * Other modes retain their no-material-GC-regression rule. Measure allocation separately.
 * Restored mode includes transport/SSE replay; other modes measure preparation only.
 * No mode measures live provider calls or whole-Gateway latency.
 * --turns 100|500 uses three messages/turn and ~40 KiB tool results; --hook
 * none|observer|service-tier selects no hook, an observer, or the bundled tier wrapper.
 * --diagnostics reports cold/warm/appended encode work separately from timing passes.
 * --interval-ms 200 paces each request to compare memory at five requests/second.
 * --cpu-profile attributes sampled CPU separately from timing/allocation runs.
 * ownerSites attributes copy, comparison, inspection and encoding work; multiply
 * bytes/request by the workload's requests/minute for a normalized allocation rate.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { Session, type HeapProfiler, type Profiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import type { AnthropicOptions } from "../../packages/ai/src/provider-options.js";
import type { Context, Model } from "../../packages/llm-core/src/types.js";
import { summarizeGcByKind } from "../lib/gc-profile-summary.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    messages: { type: "string", default: "40" },
    mode: { type: "string", default: "full" },
    iterations: { type: "string" },
    allocation: { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    retained: { type: "boolean", default: false },
    "prepared-system": { type: "boolean", default: false },
    images: { type: "boolean", default: false },
    restored: { type: "boolean", default: false },
    turns: { type: "string" },
    hook: { type: "string" },
    diagnostics: { type: "boolean", default: false },
    "interval-ms": { type: "string" },
    "baseline-dir": { type: "string" },
  },
});
assert(values.messages === "40" || values.messages === "150", "--messages must be 40 or 150");
assert(
  ["full", "build", "serialize", "system"].includes(values.mode),
  "--mode must be full, build, serialize or system",
);
assert(values.turns === undefined || ["100", "500"].includes(values.turns));
assert(values.hook === undefined || ["none", "observer", "service-tier"].includes(values.hook));
const messageCount = values.turns
  ? Number(values.turns) * 3
  : values.images
    ? 48
    : Number(values.messages);
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: values.restored ? 20 : 2000,
  min: 1,
  label: "iterations",
});
const intervalMs = parseStrictIntegerOption({
  raw: values["interval-ms"],
  fallback: 0,
  min: 0,
  label: "interval-ms",
});
if (values["baseline-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["baseline-dir"]);
  await import("./worker-retained-heap-preload.js");
}
if (values.restored) {
  const { measureRestoredAnthropicSession } = await import("./anthropic-restored-session.js");
  await measureRestoredAnthropicSession({ iterations, allocation: values.allocation });
  process.exit(0);
}
const { prepareSystemPrompt, SYSTEM_PROMPT_CACHE_BOUNDARY } =
  await import("../../packages/ai/src/utils/system-prompt-cache-boundary.js");
const { configureAiTransportHost, getAiTransportHost } =
  await import("../../packages/ai/src/host.js");
const { buildAnthropicSystemBlocks } =
  await import("../../packages/ai/src/transports/anthropic-payload-policy.js");
const { buildAnthropicRequest, prepareAnthropicRequest } =
  await import("../../packages/ai/src/transports/anthropic-messages.js");
const { transformTransportMessages } =
  await import("../../src/agents/transport-message-transform.js");
const { freezeJsonSnapshot, isDeeplyFrozenPlainData, isPlainData } =
  await import("../../src/shared/immutable-data.js");
const { normalizeAnthropicInlineContentBlocks } =
  await import("../../src/media/anthropic-inline-images.js");
const defaultHost = getAiTransportHost();
configureAiTransportHost({
  resolveProviderRequestCapabilities: (input) => ({
    ...defaultHost.resolveProviderRequestCapabilities(input),
    endpointClass: "anthropic-public",
    allowsAnthropicServiceTier: true,
  }),
  normalizeAnthropicInlineContentBlocks,
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
  input: values.images ? ["text", "image"] : ["text"],
  contextWindow: 200000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const messages: Context["messages"] = [];
for (let index = 0; index < messageCount; index++) {
  const turn = Math.floor(index / 3);
  const text =
    `Synthetic ${index}: ` +
    'line "quoted" \\ café 🦞\n'.repeat(values.turns && index % 3 === 2 ? 1600 : 160);
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
if (values.images) {
  // Synthetic PNG headers exercise MIME sniffing without invoking a native image codec.
  const bytes = Buffer.alloc(64 * 1024, 0xa7);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(bytes);
  for (let index = 0; index < 36; index += 6) {
    for (const offset of [0, 2]) {
      const message = messages[index + offset]!;
      assert(message.role === "toolResult" || message.role === "user");
      assert(Array.isArray(message.content));
      bytes.writeUInt32BE(index + offset, 32);
      message.content.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: "image/png",
      });
    }
  }
}
messages.slice(0, -1).forEach(freezeJsonSnapshot);
let context: Context | undefined = {
  systemPrompt:
    "Synthetic system block. ".repeat(values["prepared-system"] ? 2800 : 100) +
    (values["prepared-system"] ? `${SYSTEM_PROMPT_CACHE_BOUNDARY}Runtime facts.` : ""),
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
if (values["prepared-system"]) {
  context.preparedSystemPrompt = prepareSystemPrompt(context.systemPrompt!);
}
const options: AnthropicOptions = {
  cacheRetention: "long",
  thinkingEnabled: true,
  onPayload: () => undefined,
};
if (values.hook === "none") {
  delete options.onPayload;
} else if (values.hook === "service-tier") {
  const host = getAiTransportHost();
  const { createAnthropicServiceTierWrapper } =
    await import("../../extensions/anthropic/stream-wrappers.js");
  const { AssistantMessageEventStream } =
    await import("../../packages/ai/src/utils/event-stream.js");
  configureAiTransportHost(host);
  await createAnthropicServiceTierWrapper((_model, _context, wrapped) => {
    options.onPayload = wrapped?.onPayload;
    return new AssistantMessageEventStream();
  }, "auto")(model, context, options);
  const probe = {};
  await options.onPayload?.(probe, model);
  assert.equal(Reflect.get(probe, "service_tier"), "auto");
}
const serialize =
  values["baseline-dir"] && !values.images && !values.hook
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
  // Guarded fetch flattens older Blob bodies; owned encoded bytes pass through.
  return consumeBody(encoded);
}
async function consumeBody(
  body: string | Blob | Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return typeof body === "string"
    ? encoder.encode(body)
    : body instanceof Blob
      ? new Uint8Array(await body.arrayBuffer())
      : body;
}
async function collect(): Promise<void> {
  for (let index = 0; index < 3; index++) {
    await setImmediate();
    globalThis.gc?.();
  }
}
if (values.diagnostics) {
  assert(serialize);
  const nativeStringify = JSON.stringify;
  const nativeDescriptor = Object.getOwnPropertyDescriptor;
  const nativeOwnKeys = Reflect.ownKeys;
  const NativeBlob = Blob;
  const counts = {
    messageEncodes: 0,
    wholeEncodes: 0,
    encodedBytes: 0,
    blobAssemblyMs: 0,
    frozenChecks: 0,
    frozenCheckMs: 0,
    plainChecks: 0,
    plainCheckMs: 0,
    descriptorReads: 0,
    ownKeyWalks: 0,
  };
  configureAiTransportHost({
    ...getAiTransportHost(),
    immutableData: {
      freezeJsonSnapshot,
      isPlainData(value) {
        const start = performance.now();
        const result = isPlainData(value);
        counts.plainCheckMs += performance.now() - start;
        counts.plainChecks++;
        return result;
      },
      isDeeplyFrozenPlainData(value) {
        const start = performance.now();
        const result = isDeeplyFrozenPlainData(value);
        counts.frozenCheckMs += performance.now() - start;
        counts.frozenChecks++;
        return result;
      },
    },
  });
  Object.getOwnPropertyDescriptor = (value, key) => {
    counts.descriptorReads++;
    return nativeDescriptor(value, key);
  };
  Reflect.ownKeys = (value) => {
    counts.ownKeyWalks++;
    return nativeOwnKeys(value);
  };
  JSON.stringify = (value, replacer, space) => {
    const result =
      typeof replacer === "function"
        ? nativeStringify(value, replacer, space)
        : nativeStringify(value, replacer, space);
    if (value && typeof value === "object") {
      const message = ["user", "assistant"].includes(Reflect.get(value, "role"));
      const whole = Array.isArray(Reflect.get(value, "messages"));
      if (message) {
        counts.messageEncodes++;
      }
      if (whole) {
        counts.wholeEncodes++;
      }
      if ((message || whole) && result) {
        counts.encodedBytes += Buffer.byteLength(result);
      }
    }
    return result;
  };
  globalThis.Blob = class extends NativeBlob {
    constructor(...args: ConstructorParameters<typeof Blob>) {
      const start = performance.now();
      super(...args);
      if (args[1]?.type === "application/json") {
        counts.blobAssemblyMs += performance.now() - start;
      }
    }
  };
  try {
    for (const phase of ["cold", "warm", "appended"]) {
      if (phase === "appended") {
        messages.push(
          freezeJsonSnapshot({ role: "user", timestamp: messageCount, content: "New tail" }),
        );
      }
      for (const key of Object.keys(counts)) {
        Reflect.set(counts, key, 0);
      }
      const prepared = await build();
      const serializeStart = performance.now();
      const body = serialize(prepared.params, prepared.messageSources);
      const serializationMs = performance.now() - serializeStart;
      const consumeStart = performance.now();
      const bytes = await consumeBody(body);
      const consumeMs = performance.now() - consumeStart;
      const wire = new TextDecoder().decode(bytes);
      assert.equal(wire, nativeStringify(prepared.params));
      console.log(
        nativeStringify({
          phase,
          messages: prepared.params.messages.length,
          hook: values.hook,
          ...counts,
          serializationMs,
          consumeMs,
          reusedMessageFragments: counts.wholeEncodes
            ? 0
            : prepared.params.messages.length - counts.messageEncodes,
          wireBytes: Buffer.byteLength(wire),
          sha256: hash("sha256", wire),
        }),
      );
    }
  } finally {
    JSON.stringify = nativeStringify;
    Object.getOwnPropertyDescriptor = nativeDescriptor;
    Reflect.ownKeys = nativeOwnKeys;
    globalThis.Blob = NativeBlob;
  }
  process.exit(0);
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
let lastSystem: ReturnType<typeof buildAnthropicSystemBlocks>;
async function run() {
  for (let index = 0; index < iterations; index++) {
    const requestStart = intervalMs ? performance.now() : 0;
    if (values.mode === "system") {
      assert(context);
      lastSystem = buildAnthropicSystemBlocks(
        context.systemPrompt,
        false,
        { type: "ephemeral", ttl: "1h" },
        undefined,
        context.preparedSystemPrompt,
      );
      continue;
    }
    if (values.mode !== "serialize") {
      changeTail(index);
    }
    lastPrepared = values.mode === "serialize" ? prepared : await build();
    last = values.mode === "build" ? undefined : await encode(lastPrepared);
    if (intervalMs) {
      await delay(Math.max(0, intervalMs - (performance.now() - requestStart)));
    }
  }
}
async function verifyLast() {
  if (values.mode === "system") {
    assert.deepEqual(lastSystem, prepared.params.system);
  }
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
assert(!(values.allocation && values["cpu-profile"]), "Profile CPU and allocation separately");
if (values.allocation || values["cpu-profile"]) {
  inspector.connect();
}
if (values["cpu-profile"]) {
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.setSamplingInterval", { interval: 100 });
  await inspector.post("Profiler.start");
}
if (values.allocation) {
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
const ownerNames = new Set([
  "copyPlainData",
  "samePlainData",
  "inspectPlainData",
  "isDeeplyFrozenPlainData",
  "encodeMessageFragment",
]);
const ownerSites = new Map<string, number>();
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const totals = new Map<string, number>();
  const sum = (node: HeapProfiler.SamplingHeapProfileNode, owner?: string): number => {
    const name = `${node.callFrame.functionName}@${node.callFrame.url.split("/").at(-1)}`;
    totals.set(name, (totals.get(name) ?? 0) + node.selfSize);
    const current = ownerNames.has(node.callFrame.functionName)
      ? node.callFrame.functionName
      : owner;
    if (current) {
      ownerSites.set(current, (ownerSites.get(current) ?? 0) + node.selfSize);
    }
    return node.selfSize + node.children.reduce((total, child) => total + sum(child, current), 0);
  };
  allocationBytesPerRequest = sum(profile.head) / iterations;
  sites = [...totals]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, bytes]) => ({ name, bytesPerRequest: bytes / iterations }));
}
if (values["cpu-profile"]) {
  const { profile } = await inspector.post("Profiler.stop");
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const owners = new Map<number, string>();
  const visit = (node: Profiler.ProfileNode, owner?: string): void => {
    const current = ownerNames.has(node.callFrame.functionName)
      ? node.callFrame.functionName
      : owner;
    if (current) {
      owners.set(node.id, current);
    }
    for (const id of node.children ?? []) {
      const child = nodes.get(id);
      if (child) {
        visit(child, current);
      }
    }
  };
  const root = profile.nodes[0];
  if (root) {
    visit(root);
  }
  for (const [index, id] of (profile.samples ?? []).entries()) {
    const owner = owners.get(id);
    if (owner) {
      ownerSites.set(owner, (ownerSites.get(owner) ?? 0) + (profile.timeDeltas?.[index] ?? 0));
    }
  }
}
inspector.disconnect();
const expectedWire = await verifyLast();
const memoryBeforeFinalGc = process.memoryUsage();
globalThis.gc?.();
console.log(
  JSON.stringify({
    messages: messageCount,
    mode: values.mode,
    preparedSystem: values["prepared-system"],
    images: values.images ? 12 : 0,
    turns: values.turns,
    hook: values.hook,
    intervalMs,
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
    gcByKind: summarizeGcByKind(collections),
    memoryBeforeFinalGc,
    memory: process.memoryUsage(),
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    sites,
    ownerSites: Object.fromEntries(
      [...ownerSites].map(([name, total]) => [name, total / iterations]),
    ),
    ownerSiteUnits: values.allocation ? "bytes/request" : "sampled-us/request",
  }),
);
