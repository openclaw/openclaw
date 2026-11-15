// Fork-capture owner proof; synthetic transport, never a live Gateway.
// node --expose-gc scripts/perf/session-fork-retention-measure.mjs SOURCE_ROOT --mode retention
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  performance,
} from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [sourceRoot, ...args] = process.argv.slice(2);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
assert(sourceRoot, "supply a source root");
const mode = value("--mode", "timing");
assert(["timing", "allocation", "count", "retention"].includes(mode));
const operations = Number(value("--operations", "27000"));
const sessions = Number(value("--sessions", "200"));
const payloadBytes = Number(value("--payload-bytes", String(256 * 1024)));
const warmup = Number(value("--warmup", String(sessions)));
const output = value("--output");
const warmReady = value("--warm-ready-file");
const warmStart = value("--warm-start-file");
const ready = value("--ready-file");
const start = value("--start-file");
assert(operations > 0 && sessions > 0 && payloadBytes >= 1024);
assert(mode !== "retention" || globalThis.gc, "retention mode requires --expose-gc");

const sourcePaths = [
  "src/agents/embedded-agent-runner/session-fork.ts",
  "src/agents/embedded-agent-runner/stream-resolution.ts",
  "src/shared/immutable-data.ts",
  "packages/ai/src/transports/model-request-body.ts",
  "packages/normalization-core/src/record-coerce.ts",
];
const sourceNames = new Set(sourcePaths.map((file) => path.basename(file, ".ts")));
const adapters = `
// Only unrelated host/provider/authority boundaries are adapted.
export const getAiTransportHost = () => ({
  runInDetachedAsyncContext: fn => fn(),
  inheritManagedTransport: (_model, replacement) => replacement,
});
export const registerSessionResourceCleanup = () => {};
export const isCredentialFieldName = () => { throw new Error("Headers are outside this probe"); };
export const independentResponsesRequest = { set() {} };
export const responsesRequestLifecycle = { set() {} };
export const preparedRequestSuffix = { mark() {} };
export const withGuardedFetchRequestAuthority = async (check, fn) => { check(); return fn(); };
export const collectTextContentBlocks = blocks => blocks.filter(x => x.type === "text").map(x => x.text);
export const normalizeUsage = () => undefined;
export const createUsageAccumulator = () => ({});
export const mergeUsageIntoAccumulator = () => {};
export const toNormalizedUsage = () => undefined;
export const notifyLlmRequestActivity = () => {};
export const onLlmRequestActivity = () => {};
export const stripSystemPromptCacheBoundary = text => text;
let measuredTransport;
export const setMeasuredTransport = transport => { measuredTransport = transport; };
export const createBoundaryAwareStreamFnForModel = () => measuredTransport;
export const hasNonEmptyString = value => typeof value === "string" && value.trim().length > 0;
export const getStreamLlmRuntime = () => undefined;
export const admitProviderRateLimitStream = (_model, options, send, check) => { check?.(); return send(options); };
export const createAnthropicVertexStreamFnForModel = () => { throw new Error("Wrong route"); };
`;
const adapterNames = new Set([
  "@openclaw/ai",
  "@openclaw/ai/internal/runtime",
  "@openclaw/ai/internal/shared",
  "@openclaw/ai/transports",
  "@openclaw/normalization-core/string-coerce",
  "fetch-request-authority",
  "content-blocks",
  "usage",
  "usage-accumulator",
  "model-runtime-binding",
  "provider-rate-limit-stream",
  "ai-transport-runtime-host",
  "anthropic-vertex-stream",
]);
const generatedRoot = mkdtempSync(path.join(tmpdir(), "session-fork-measure-"));
const url = `${pathToFileURL(generatedRoot).href}/`;
const hashes = {};
for (const file of sourcePaths) {
  const source = readFileSync(path.join(sourceRoot, file), "utf8");
  hashes[file] = createHash("sha256").update(source).digest("hex");
  writeFileSync(path.join(generatedRoot, path.basename(file)), source);
}
writeFileSync(path.join(generatedRoot, "adapters.mjs"), adapters);
writeFileSync(
  path.join(generatedRoot, "openai.mjs"),
  'export { modelRequestBodyState } from "./model-request-body.ts";\n' +
    'export { independentResponsesRequest, responsesRequestLifecycle } from "./adapters.mjs";\n',
);
writeFileSync(
  path.join(generatedRoot, "v8-count.mjs"),
  `import { serialize as encode, deserialize } from "node:v8";
export { deserialize };
export const counts = { calls: 0, bytes: 0 };
export function serialize(value) {
  const encoded = encode(value);
  counts.calls++;
  counts.bytes += encoded.byteLength;
  return encoded;
}
`,
);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      mode === "count" &&
      specifier === "node:v8" &&
      context.parentURL?.startsWith(url) &&
      !context.parentURL.endsWith("v8-count.mjs")
    ) {
      return { url: `${url}v8-count.mjs`, shortCircuit: true };
    }
    if (!context.parentURL?.startsWith(url) || specifier.startsWith("node:")) {
      return nextResolve(specifier, context);
    }
    if (specifier === "@openclaw/ai/internal/openai") {
      return { url: `${url}openai.mjs`, shortCircuit: true };
    }
    const name = path.basename(specifier).replace(/\.(?:js|ts)$/, "");
    if (sourceNames.has(name)) {
      return { url: `${url}${name}.ts`, shortCircuit: true };
    }
    if (adapterNames.has(specifier) || adapterNames.has(name)) {
      return { url: `${url}adapters.mjs`, shortCircuit: true };
    }
    if (specifier === "./adapters.mjs") {
      return nextResolve(specifier, context);
    }
    throw new Error(`Unreviewed dependency: ${specifier}`);
  },
});
process.once("exit", () => rmSync(generatedRoot, { recursive: true, force: true }));
const owner = {
  ...(await import(`${url}session-fork.ts`)),
  ...(await import(`${url}stream-resolution.ts`)),
  ...(await import(`${url}model-request-body.ts`)),
};
const { counts: v8Counts } = await import(`${url}v8-count.mjs`);
const model = {
  id: "synthetic-model",
  name: "Synthetic",
  api: "openai-responses",
  provider: "synthetic",
  baseUrl: "https://synthetic.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 200000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const result = {
  role: "assistant",
  api: model.api,
  provider: model.provider,
  model: model.id,
  content: [{ type: "text", text: "Synthetic completed answer. ".repeat(40) }],
  stopReason: "stop",
  timestamp: 2,
};
let sent = 0;
let encodedBytes = 0;
const transport = async (_model, context, options) => {
  const encode = owner.prepareModelRequestBody(options);
  const payload = { model: model.id, input: context.messages, stream: true };
  const prepared = (await options.onPayload?.(payload, model)) ?? payload;
  // Three quarters of requests use the existing HTTP continuation suffix path.
  const continuation = sent++ % 4 !== 0;
  const encoded = await encode(
    continuation
      ? {
          ...prepared,
          input: [{ role: "user", content: "Continue" }],
          previous_response_id: "resp_synthetic",
        }
      : prepared,
  );
  encodedBytes += encoded.body.size;
  return { result: async () => result };
};
const { setMeasuredTransport } = await import(`${url}adapters.mjs`);
setMeasuredTransport(transport);
const llmRuntime = { streamSimple: transport, registry: { getApiProvider: () => undefined } };
const fixtures = Array.from({ length: sessions }, (_, index) => {
  const identity = { sessionId: `synthetic-${index}`, runId: `run-${index}`, agentId: "synthetic" };
  const context = {
    systemPrompt: "Stable synthetic instructions",
    messages: [
      { role: "user", content: `${index}:` + "x".repeat(payloadBytes - 128), timestamp: 1 },
    ],
  };
  // The actual selection owner installs capture on baseline and has no such path on candidate.
  const { streamFn, strategy } = owner.resolveEmbeddedAgentStream({
    llmRuntime,
    currentStreamFn: transport,
    sessionId: identity.sessionId,
    promptCacheKey: identity.sessionId,
    model,
    sessionFork: identity,
  });
  assert.equal(strategy, "boundary-aware:openai-responses");
  return { identity, context, streamFn };
});
async function work(count, latencies) {
  for (let index = 0; index < count; index++) {
    const fixture = fixtures[index % sessions];
    const before = latencies ? performance.now() : 0;
    await (await fixture.streamFn(model, fixture.context, {})).result();
    // The subscription dispatcher called this owner before the capture path was retired.
    owner.recordEmbeddedSessionForkMessage?.(
      fixture.identity.sessionId,
      fixture.identity.runId,
      result,
    );
    if (latencies) {
      latencies.push(performance.now() - before);
    }
    if (index % 16 === 15) {
      await nextTurn();
    }
  }
}
async function barrier(readyPath, startPath) {
  if (!startPath) {
    return;
  }
  assert(readyPath, "barriers require ready and start paths");
  writeFileSync(readyPath, String(process.pid));
  while (!existsSync(startPath)) {
    await delay(25);
  }
  const epoch = Number(readFileSync(startPath, "utf8"));
  assert(epoch > Date.now(), "missed synchronized start");
  await delay(epoch - Date.now());
}
async function settledMemory() {
  for (let pass = 0; pass < 3; pass++) {
    await nextTurn();
    globalThis.gc();
  }
  return process.memoryUsage();
}
function distribution(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const quantile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return {
    samples: sorted.length,
    totalMs: sorted.reduce((a, b) => a + b, 0),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    maxMs: sorted.at(-1) ?? null,
  };
}
await barrier(warmReady, warmStart);
await work(warmup);
owner.clearEmbeddedSessionForkSnapshot?.();
await nextTurn();
const beforeMemory = mode === "retention" ? await settledMemory() : process.memoryUsage();
const inspector = mode === "allocation" ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
await barrier(ready, start);
const gcRows = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcRows.push({ kind: entry.detail.kind, duration: entry.duration });
  }
});
observer.observe({ entryTypes: ["gc"] });
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const counts = { jsonStringify: 0, jsonBytes: 0, blobs: 0, timers: 0 };
const realStringify = JSON.stringify;
const RealBlob = globalThis.Blob;
const realSetTimeout = globalThis.setTimeout;
if (mode === "count") {
  JSON.stringify = (...input) => {
    const json = realStringify(...input);
    counts.jsonStringify++;
    counts.jsonBytes += Buffer.byteLength(json ?? "");
    return json;
  };
  globalThis.Blob = new Proxy(RealBlob, {
    construct(target, input) {
      counts.blobs++;
      return Reflect.construct(target, input);
    },
  });
  globalThis.setTimeout = (...input) => {
    counts.timers++;
    return realSetTimeout(...input);
  };
}
v8Counts.calls = 0;
v8Counts.bytes = 0;
const beforeCpu = process.cpuUsage();
const beforeThreadCpu = process.threadCpuUsage();
const startedAt = Date.now();
const started = performance.now();
sent = 0;
encodedBytes = 0;
const latencies = [];
await work(operations, mode === "timing" ? latencies : undefined);
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(beforeCpu);
const threadCpu = process.threadCpuUsage(beforeThreadCpu);
loop.disable();
await nextTurn();
observer.disconnect();
JSON.stringify = realStringify;
globalThis.Blob = RealBlob;
globalThis.setTimeout = realSetTimeout;
let sampledBytes;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
const afterMemory = mode === "retention" ? await settledMemory() : process.memoryUsage();
const kinds = {
  minor: constants.NODE_PERFORMANCE_GC_MINOR,
  major: constants.NODE_PERFORMANCE_GC_MAJOR,
  incremental: constants.NODE_PERFORMANCE_GC_INCREMENTAL,
  weak: constants.NODE_PERFORMANCE_GC_WEAKCB,
};
const report = {
  protocol: "session-fork-pay-on-fork-owner-v2",
  runtime: process.version,
  mode,
  hashes,
  workload: {
    operations,
    sessions,
    payloadBytes,
    continuationFraction: 0.75,
    warmup,
    equivalentTrafficMinutesAt450Rpm: operations / 450,
  },
  scope:
    "Actual stream-selection/capture/encoding owners; synthetic provider and adapted host boundaries. No Gateway or paid provider calls.",
  limits:
    "Retention is a compressed one-hour-equivalent traffic sequence, not an elapsed-hour Gateway soak. Fixture messages remain live equally on both sides. No promotion measurement. Heap/external/ArrayBuffers overlap and are reported separately.",
  captureApiPresent: typeof owner.wrapStreamFnWithSessionFork === "function",
  startedAt,
  elapsedMs,
  cpuUsPerTurn: (cpu.user + cpu.system) / operations,
  mainThreadCpuUsPerTurn: (threadCpu.user + threadCpu.system) / operations,
  encodedBytes,
  sent,
  counts:
    mode === "count"
      ? { ...counts, v8Serialize: v8Counts.calls, v8Bytes: v8Counts.bytes }
      : undefined,
  sampledBytes,
  sampledBytesPerTurn: sampledBytes === undefined ? undefined : sampledBytes / operations,
  latency: distribution(latencies),
  gc: distribution(gcRows.map((row) => row.duration)),
  gcMsPerTurn: gcRows.reduce((sum, row) => sum + row.duration, 0) / operations,
  gcByKind: Object.fromEntries(
    Object.entries(kinds).map(([name, kind]) => [
      name,
      distribution(gcRows.filter((row) => row.kind === kind).map((row) => row.duration)),
    ]),
  ),
  loop: {
    samples: loop.count,
    p95Ms: loop.percentile(95) / 1e6,
    p99Ms: loop.percentile(99) / 1e6,
    maxMs: loop.max / 1e6,
  },
  beforeMemory,
  afterMemory,
  retainedDelta: Object.fromEntries(
    ["heapUsed", "external", "arrayBuffers", "rss"].map((key) => [
      key,
      afterMemory[key] - beforeMemory[key],
    ]),
  ),
};
if (output) {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
owner.clearEmbeddedSessionForkSnapshot?.();
hooks.deregister();
