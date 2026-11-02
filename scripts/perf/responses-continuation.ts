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
 *     > packages/ai/src/transports/.responses-continuation-baseline.ts
 * Pass that file to --module, then remove it after comparison. Keeping it beside
 * the owner preserves relative imports; dependencies must match both revisions.
 * Commit flow uses real claim/commit across each conversation, then cleanup.
 * Explicit previous_response_id isolates commit from history comparison; it is not a
 * Gateway or model-turn latency measurement. Prefix flow hashes full prefixes.
 * Resolve flow measures the continuation decision with cloned replay history;
 * preparation, commit accounting, and wire encoding are outside that window.
 * Allocation sampling includes collected objects. Its CPU is diagnostic only.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import { configureAiTransportHost } from "../../packages/ai/src/host.js";
import { cleanupSessionResources } from "../../packages/ai/src/session-resources.js";
import type {
  ResponsesContinuationRequest,
  ResponsesContinuationState,
} from "../../packages/ai/src/transports/openai-responses-continuation.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../src/shared/immutable-data.js";
import { summarizeGcByKind } from "../lib/gc-profile-summary.ts";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    flow: { type: "string", default: "commit" },
    conversations: { type: "string", default: "10" },
    frozen: { type: "boolean", default: false },
    "initial-turns": { type: "string", default: "0" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values.flow === "commit" || values.flow === "prefix" || values.flow === "resolve");
const conversations = Number(values.conversations);
assert(Number.isSafeInteger(conversations) && conversations > 0);
assert(globalThis.gc, "Use --expose-gc");
const modulePath = values.module
  ? resolve(values.module)
  : fileURLToPath(
      new URL("../../packages/ai/src/transports/openai-responses-continuation.ts", import.meta.url),
    );
const owner: typeof import("../../packages/ai/src/transports/openai-responses-continuation.js") =
  await import(pathToFileURL(modulePath).href);
const turns = 200;
const initialTurns = Number(values["initial-turns"]);
assert(Number.isSafeInteger(initialTurns) && initialTurns >= 0);
if (values.frozen) {
  configureAiTransportHost({ immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData } });
}
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
  if (index % 25 === 0) {
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
    input: structuredClone([
      ...(request.input ?? []),
      ...response.output,
      { type: "message" as const, role: "user" as const, content: "Continue" },
    ]),
  },
}));
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
  }),
);
