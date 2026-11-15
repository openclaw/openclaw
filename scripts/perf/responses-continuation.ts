/**
 * Responses retention/prefix owner benchmark: 200-turn conversations, ~4 KiB new
 * text per turn, assistant calls + tool results, prepared before measurement.
 * Run separate timing and allocation processes, alternating baseline/candidate:
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/responses-continuation.ts \
 *     --flow commit --conversations 10 [--allocation] [--module <path>]
 * For long mixed history use --initial-turns 120 --frozen (600+ items, images/reasoning).
 * Accept exact byte-budget parity and CPU/allocation reductions beyond A/A spread;
 * use at least five alternating samples per side, timing and allocation separately.
 * Repeat with --flow prefix or --flow resolve. Defaults to the working-tree owner. For a baseline:
 *   git show <base>:packages/ai/src/transports/openai-responses-continuation.ts \
 *     > /path/to/baseline.ts
 * Pass that file to --module; the loader replaces the original owner URL so
 * relative imports stay intact. Dependencies must match both revisions.
 * Commit flow uses real claim/commit across each conversation, then cleanup.
 * Explicit previous_response_id isolates commit from history comparison; it is not a
 * Gateway or model-turn latency measurement. Prefix flow hashes full prefixes.
 * Resolve flow measures the continuation decision with cloned replay history;
 * --reuse-input --frozen carries conversion-owned immutable identities forward;
 * --image-every 0 isolates text/tool history (default: one mutable image per 25 turns).
 * Preparation, commit accounting, and wire encoding are outside that window.
 * Allocation sampling includes collected objects. Its CPU is diagnostic only.
 * Retained-heap flow: --flow retention --sessions 20 --messages 2000 [--snapshot <path>].
 * Run fresh processes for each base/candidate arm, N=1/10/20 and 200/2000 items.
 * It holds independent frozen histories with 16 KiB tool results and rebuilt images,
 * resolves once per session, reports heapUsed after full GC, then releases histories.
 * --snapshot writes the live heap under the supplied path; count nodes/edges outside
 * this process. --retention-gc --trace-gc-nvp is a separate major-marking diagnostic.
 * Ten tiny disposable histories warm the owner before the empty-heap measurement.
 * Measured histories resolve once each; ordinary heap runs exclude GC instrumentation.
 * --retained-sampling reports objEquiv allocation before/after terminal full GC.
 * Combine it with --snapshot for allocation-traced survivor inspection.
 */
import assert from "node:assert/strict";
import { createHash, hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler, writeHeapSnapshot } from "node:v8";
import { configureAiTransportHost } from "../../packages/ai/src/host.js";
import { cleanupSessionResources } from "../../packages/ai/src/session-resources.js";
import type {
  ResponsesContinuationRequest,
  ResponsesContinuationState,
} from "../../packages/ai/src/transports/openai-responses-continuation.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../src/shared/immutable-data.js";
import { summarizeGcByKind } from "../lib/gc-profile-summary.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    flow: { type: "string", default: "commit" },
    conversations: { type: "string", default: "10" },
    frozen: { type: "boolean", default: false },
    "reuse-input": { type: "boolean", default: false },
    "image-every": { type: "string", default: "25" },
    "initial-turns": { type: "string", default: "0" },
    allocation: { type: "boolean", default: false },
    sessions: { type: "string", default: "1" },
    messages: { type: "string", default: "200" },
    snapshot: { type: "string" },
    "retention-gc": { type: "boolean", default: false },
    "retained-sampling": { type: "boolean", default: false },
  },
});
assert(["commit", "prefix", "resolve", "retention"].includes(values.flow));
const conversations = Number(values.conversations);
assert(Number.isSafeInteger(conversations) && conversations > 0);
assert(globalThis.gc, "Use --expose-gc");
const ownerUrl = new URL(
  "../../packages/ai/src/transports/openai-responses-continuation.ts",
  import.meta.url,
);
const modulePath = values.module ? resolve(values.module) : fileURLToPath(ownerUrl);
const replaced = registerPerfOwnerReplacement(ownerUrl.href, values.module);
const owner: typeof import("../../packages/ai/src/transports/openai-responses-continuation.js") =
  await import(ownerUrl.href);
assert.equal(replaced(), Boolean(values.module));
if (values.flow === "retention") {
  const sessions = Number(values.sessions);
  const messages = Number(values.messages);
  assert(Number.isSafeInteger(sessions) && sessions > 0);
  assert(Number.isSafeInteger(messages) && messages >= 10 && messages % 5 === 0);
  configureAiTransportHost({ immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData } });
  async function collect() {
    await nextTurn();
    globalThis.gc!();
    await nextTurn();
    globalThis.gc!();
    return process.memoryUsage().heapUsed;
  }
  function createRetainedSession(session: number, itemCount: number) {
    const input: NonNullable<ResponsesContinuationRequest["input"]> = [];
    for (let turn = 0; turn < itemCount / 5; turn++) {
      const callId = `call_${session}_${turn}`;
      const text = (prefix: string, length: number) =>
        Buffer.from(`${prefix}-${session}-${turn}:`.padEnd(length, "x")).toString();
      const message: NonNullable<ResponsesContinuationRequest["input"]>[number] =
        turn % 25 === 0
          ? {
              role: "user",
              content: [
                {
                  type: "input_image",
                  detail: "auto",
                  image_url: `https://fixture.invalid/${session}/${turn}.png`,
                },
              ],
            }
          : freezeJsonSnapshot({
              role: "user",
              content: [{ type: "input_text", text: text("question", 1024) }],
            });
      input.push(
        message,
        ...freezeJsonSnapshot([
          {
            type: "function_call" as const,
            call_id: callId,
            name: "lookup",
            arguments: '{"query":"fixture"}',
          },
          {
            type: "function_call_output" as const,
            call_id: callId,
            output: text("result", 16_384),
          },
          {
            type: "reasoning" as const,
            id: `rs_${session}_${turn}`,
            summary: [],
            encrypted_content: "sealed",
          },
          {
            type: "message" as const,
            id: `msg_${session}_${turn}`,
            status: "completed" as const,
            role: "assistant" as const,
            content: [
              { type: "output_text" as const, text: text("answer", 1024), annotations: [] },
            ],
          },
        ]),
      );
    }
    const state: ResponsesContinuationState = {
      lastRequest: { model: "fixture-model", store: true, input },
      lastResponseId: `resp_${session}`,
      lastResponseItems: [],
    };
    const request: ResponsesContinuationRequest = {
      ...state.lastRequest,
      input: [
        ...input.map((item) => (isDeeplyFrozenPlainData(item) ? item : structuredClone(item))),
        { role: "user", content: "Continue" },
      ],
    };
    return { state, request };
  }
  function resolveRetainedRequests(entries: ReturnType<typeof createRetainedSession>[]) {
    for (const { state, request } of entries) {
      const result = owner.resolveResponsesContinuationRequest(state, request);
      assert.equal(result.continuationStatus, "continued");
      assert.equal(result.request.previous_response_id, state.lastResponseId);
      assert.equal(result.request.input?.length, 1);
    }
  }
  resolveRetainedRequests(
    Array.from({ length: 10 }, (_, index) => createRetainedSession(-index - 1, 20)),
  );
  const emptyHeap = await collect();
  const held = Array.from({ length: sessions }, (_, session) =>
    createRetainedSession(session, messages),
  );
  const references = held.flatMap(({ state }) => {
    const input = state.lastRequest.input!;
    const frozenMessage = input[5];
    assert(frozenMessage);
    return [new WeakRef(input), new WeakRef(frozenMessage)];
  });
  const preparedHeap = await collect();
  const sampling = values["retained-sampling"] ? new Session() : undefined;
  function comparisonBytes(profile: HeapProfiler.SamplingHeapProfile): number {
    function visit(node: HeapProfiler.SamplingHeapProfileNode, comparison = false): number {
      const inComparison = comparison || node.callFrame.functionName === "objEquiv";
      return (
        (inComparison ? node.selfSize : 0) +
        node.children.reduce((total, child) => total + visit(child, inComparison), 0)
      );
    }
    return visit(profile.head);
  }
  if (sampling) {
    sampling.connect();
    if (values.snapshot) {
      await sampling.post("HeapProfiler.startTrackingHeapObjects", { trackAllocations: true });
    }
    await sampling.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: false,
      includeObjectsCollectedByMinorGC: false,
    });
  }
  resolveRetainedRequests(held);
  const comparisonBeforeGc = sampling
    ? comparisonBytes((await sampling.post("HeapProfiler.getSamplingProfile")).profile)
    : undefined;
  const gc = values["retention-gc"] ? new GCProfiler() : undefined;
  gc?.start();
  if (gc) {
    console.log("retention:live-gc:start");
  }
  const liveHeap = await collect();
  const comparisonAfterGc = sampling
    ? comparisonBytes((await sampling.post("HeapProfiler.stopSampling")).profile)
    : undefined;
  if (gc) {
    console.log("retention:live-gc:end");
  }
  const collections = gc?.stop()?.statistics ?? [];
  if (values.snapshot) {
    writeHeapSnapshot(resolve(values.snapshot));
  }
  sampling?.disconnect();
  // Keep the source graphs live through GC/snapshot, then test WeakMap key release.
  assert.equal(
    held.reduce((sum, entry) => sum + (entry.state.lastRequest.input?.length ?? 0), 0),
    sessions * messages,
  );
  held.length = 0;
  const releasedHeap = await collect();
  const collected = references.filter((reference) => reference.deref() === undefined).length;
  assert.equal(collected, references.length, "retained fixture after owner release");
  console.log(
    JSON.stringify({
      flow: values.flow,
      node: process.version,
      ownerSha256: hash("sha256", readFileSync(modulePath)),
      sessions,
      messages,
      collectedReferences: collected,
      diagnostic: values["retention-gc"] || values["retained-sampling"] || Boolean(values.snapshot),
      toolResultBytes: 16_384,
      emptyHeap,
      preparedHeap,
      liveHeap,
      releasedHeap,
      retainedAfterRequest: liveHeap - preparedHeap,
      comparisonBeforeGc,
      comparisonAfterGc,
      retainedPerSession: (liveHeap - preparedHeap) / sessions,
      retainedPerThousandItems: (liveHeap - preparedHeap) / ((sessions * messages) / 1000),
      gc: summarizeGcByKind(collections),
      hostLoad: loadavg(),
    }),
  );
  process.exit(0);
}
const turns = 200;
const initialTurns = Number(values["initial-turns"]);
assert(Number.isSafeInteger(initialTurns) && initialTurns >= 0);
if (values.frozen) {
  configureAiTransportHost({ immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData } });
}
const imageEvery = Number(values["image-every"]);
assert(Number.isSafeInteger(imageEvery) && imageEvery >= 0);
const history: NonNullable<ResponsesContinuationRequest["input"]> = [];
const fixtures = Array.from({ length: turns + initialTurns }, (_, index) => {
  const callId = `call_bench_${index}`;
  history.push(
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `question ${index} ${"u".repeat(1024)}` }],
    },
    { type: "function_call", call_id: callId, name: "lookup", arguments: '{"query":"fixture"}' },
    {
      type: "function_call_output",
      call_id: callId,
      output: `result ${index} ${"t".repeat(2048)}`,
    },
  );
  history.push({
    type: "reasoning",
    id: `rs_${index}`,
    summary: [],
    encrypted_content: `sealed-${index}`,
  });
  if (imageEvery > 0 && index % imageEvery === 0) {
    history.push({
      role: "user",
      content: [
        {
          type: "input_image",
          detail: "auto",
          image_url: `data:image/png;base64,${"eA==".repeat(4096)}`,
        },
      ],
    });
  }
  if (values.frozen) {
    // Conversion reuses text/tool/reasoning items, but rebuilds image publications.
    for (const item of history) {
      if (
        !(
          "content" in item &&
          Array.isArray(item.content) &&
          item.content.some((part) => part.type === "input_image")
        )
      ) {
        freezeJsonSnapshot(item);
      }
    }
  }
  const request: ResponsesContinuationRequest = {
    model: "fixture-model",
    store: true,
    ...(index > 0 ? { previous_response_id: `resp_${index - 1}` } : {}),
    input: history.slice(),
  };
  const output = [
    {
      type: "message",
      id: `msg_${index}`,
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: `answer ${index} ${"a".repeat(1024)}`,
          annotations: [],
          logprobs: [],
        },
      ],
    },
  ] satisfies ResponsesContinuationState["lastResponseItems"];
  history.push(...output);
  return { request, response: { id: `resp_${index}`, output } };
});
fixtures.splice(0, initialTurns);
const continuations = (values.flow === "resolve" ? fixtures : []).map(({ request, response }) => ({
  state: {
    lastRequest: request,
    lastResponseId: response.id,
    lastResponseItems: response.output,
  },
  request: {
    ...request,
    previous_response_id: undefined,
    input: [
      ...(request.input ?? []).map((item) =>
        values["reuse-input"] && isDeeplyFrozenPlainData(item) ? item : structuredClone(item),
      ),
      ...structuredClone(response.output),
      { type: "message" as const, role: "user" as const, content: "Continue" },
    ],
  },
}));
function requestHashes() {
  const full = createHash("sha256");
  const wire = createHash("sha256");
  const decisions = createHash("sha256");
  for (const { state, request } of continuations) {
    const result = owner.resolveResponsesContinuationRequest(state, request);
    full.update(JSON.stringify(request));
    wire.update(JSON.stringify(result.request));
    decisions.update(result.continuationStatus);
  }
  return {
    full: full.digest("hex"),
    wire: wire.digest("hex"),
    decisions: decisions.digest("hex"),
  };
}
const providerHashes = values.flow === "resolve" ? requestHashes() : undefined;
let lastHash = "";
function run(count: number): void {
  for (let conversation = 0; conversation < count; conversation++) {
    if (values.flow === "resolve") {
      for (const { state, request } of continuations) {
        const result = owner.resolveResponsesContinuationRequest(state, request);
        assert.equal(result.continuationStatus, "continued");
        assert.equal(result.request.previous_response_id, state.lastResponseId);
        assert.equal(result.request.input?.length, 1);
      }
      continue;
    }
    for (const { request, response } of fixtures) {
      if (values.flow === "prefix") {
        lastHash = owner.responsesContinuationPrefixFingerprint(
          request.input ?? [],
          response.output,
        );
      } else {
        const claim = owner.claimOpenAIResponsesHttpContinuation({
          sessionId: "continuation-owner-bench",
          apiKey: "synthetic-key",
          baseUrl: "https://provider.invalid/v1",
          headers: {},
          request,
        });
        assert(claim);
        claim.commit(request, response, request.previous_response_id);
      }
    }
    cleanupSessionResources("continuation-owner-bench");
  }
}
run(1);
const expectedHash = lastHash;
globalThis.gc();
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const gc = new GCProfiler();
gc.start();
const hostLoadBefore = loadavg();
const memoryBefore = process.memoryUsage();
const cpuBefore = process.cpuUsage();
const threadBefore = process.threadCpuUsage();
const start = performance.now();
run(conversations);
const wallMs = performance.now() - start;
const threadCpu = process.threadCpuUsage(threadBefore);
const cpu = process.cpuUsage(cpuBefore);
const memoryAfter = process.memoryUsage();
const collections = gc.stop()?.statistics ?? [];
let sampledBytes: number | undefined;
let samples: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  samples = profile.samples.length;
  inspector.disconnect();
}
assert.equal(lastHash, expectedHash);
if (providerHashes) {
  assert.deepEqual(requestHashes(), providerHashes);
}
const iterations = turns * conversations;
console.log(
  JSON.stringify({
    ownerSha256: hash("sha256", readFileSync(modulePath)),
    flow: values.flow,
    mode: values.allocation ? "allocation" : "timing",
    node: process.version,
    turnsPerConversation: turns,
    initialTurns,
    frozen: values.frozen,
    reuseInput: values["reuse-input"],
    imageEvery,
    firstInputItems: fixtures[0]?.request.input?.length,
    conversations,
    iterations,
    wallMs,
    wallNsPerTurn: (wallMs * 1e6) / iterations,
    processCpuUsPerTurn: (cpu.user + cpu.system) / iterations,
    mainThreadCpuUsPerTurn: (threadCpu.user + threadCpu.system) / iterations,
    sampledBytes,
    sampledBytesPerTurn: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    samples,
    gc: summarizeGcByKind(collections),
    memoryBefore,
    memoryAfter,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    finalPrefixHash: lastHash || undefined,
    providerHashes,
  }),
);
