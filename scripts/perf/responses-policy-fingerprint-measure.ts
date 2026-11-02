/**
 * Native Responses policy -> real input preparation -> continuation/context fingerprints.
 * --baseline points to a copy of stream-wrappers/openai.ts importing its original
 * stream-payload-utils.ts beside those owners. No network, credentials or database.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/responses-policy-fingerprint-measure.ts
 *   --baseline src/llm/providers/stream-wrappers/.lane2106-openai-baseline.ts
 * Acceptance: identical wire/fingerprint bytes, zero warm historical re-encoding,
 * lower CPU/allocation across five interleaved A/A pairs. Mutable hooks stay isolated.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createAiTransportHost, runWithAiTransportHost } from "../../packages/ai/src/host.js";
import {
  captureOpenAIResponsesCompaction,
  buildOpenAIResponsesReasoningReplayMetadata,
} from "../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import { recordResponsesContextUsage } from "../../packages/ai/src/transports/openai-responses-context-usage.js";
import { responsesContinuationPrefixFingerprint } from "../../packages/ai/src/transports/openai-responses-continuation.js";
import {
  OPENAI_RESPONSES_REASONING_REPLAY_META_KEY,
  type OpenAIResponsesOptions,
} from "../../packages/ai/src/transports/openai-responses-contracts.js";
import { buildOpenAIResponsesParams } from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import { sanitizeResponsesImagePayload } from "../../packages/ai/src/transports/responses-image-payload-sanitizer.js";
import { createAssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.js";
import type {
  AssistantMessage,
  Context,
  Model,
  StreamFn,
} from "../../packages/llm-core/src/types.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../src/shared/immutable-data.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    rounds: { type: "string", default: "20" },
    entries: { type: "string", default: "200" },
    samples: { type: "string", default: "5" },
  },
});
assert(values.baseline, "Supply original policy module beside its original helper");
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const rounds = integer(values.rounds, "rounds"),
  entries = integer(values.entries, "entries"),
  samples = integer(values.samples, "samples");
const gc = globalThis.gc;
assert(gc, "Use --expose-gc");
const model: Model = {
  id: "gpt-5.6-luna",
  name: "Synthetic",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const identity = { sessionId: "synthetic-fingerprint", authProfileId: "synthetic-profile" };
const usage = {
  input: 10,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 11,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  contextUsage: { state: "available" as const, promptTokens: 10, totalTokens: 11 },
};
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage,
  stopReason: "stop",
  timestamp: 0,
});
const host = createAiTransportHost({
  immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
});
const owners: Record<string, typeof import("../../src/llm/providers/stream-wrappers/openai.js")> =
  {};
for (const [side, source] of Object.entries({
  baseline: values.baseline,
  candidate: "src/llm/providers/stream-wrappers/openai.ts",
})) {
  owners[side] = await import(pathToFileURL(resolve(source)).href);
}
function fixture() {
  const checkpoint = assistant([]);
  captureOpenAIResponsesCompaction(
    checkpoint,
    { type: "compaction", id: "cmp_synthetic", encrypted_content: "opaque synthetic checkpoint" },
    0,
    model,
    buildOpenAIResponsesReasoningReplayMetadata(model, identity),
  );
  const messages: Context["messages"] = [freezeJsonSnapshot(checkpoint)];
  for (let i = 0; i < entries; i++) {
    const content: AssistantMessage["content"] = [];
    if (i % 10 === 0) {
      content.push({
        type: "thinking",
        thinking: "synthetic reasoning",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: `rs_${i}`,
          encrypted_content: "opaque synthetic reasoning ".repeat(64),
          summary: [],
          [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: buildOpenAIResponsesReasoningReplayMetadata(
            model,
            identity,
          ),
        }),
      });
    }
    content.push({
      type: "toolCall",
      id: `call_${i}`,
      name: "lookup",
      arguments: { query: `item ${i}` },
    });
    messages.push(
      freezeJsonSnapshot({ role: "user" as const, content: `question ${i}`, timestamp: i }),
      freezeJsonSnapshot(assistant(content)),
      freezeJsonSnapshot({
        role: "toolResult" as const,
        toolCallId: `call_${i}`,
        toolName: "lookup",
        content: [
          { type: "text" as const, text: `result ${i}: ${"synthetic output ".repeat(512)}` },
        ],
        isError: false,
        timestamp: i,
      }),
    );
  }
  return messages;
}
await runWithAiTransportHost(host, async () => {
  const inspector = new Session();
  inspector.connect();
  try {
    async function prepare(side: string, messages: Context["messages"]) {
      const policy = owners[side]!;
      let captured: ReturnType<typeof buildOpenAIResponsesParams> | undefined;
      const sink: StreamFn = (currentModel, context, options) => {
        captured = buildOpenAIResponsesParams(currentModel, context, options);
        const patched = options?.onPayload?.(captured, currentModel);
        assert(!(patched instanceof Promise), "Fixture policies are synchronous");
        captured = sanitizeResponsesImagePayload(captured);
        return createAssistantMessageEventStream();
      };
      const wrapped = policy.createOpenAITextVerbosityWrapper(
        policy.createOpenAIFastModeWrapper(
          policy.createOpenAIResponsesContextManagementWrapper(sink, {}),
        ),
        "low",
      );
      const options = { ...identity, reasoningEffort: "low" } satisfies OpenAIResponsesOptions;
      await wrapped(model, { messages, systemPrompt: "Synthetic stable instructions" }, options);
      assert(captured);
      const result = assistant([{ type: "text", text: "done" }]);
      const output = [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done", annotations: [] }],
        },
      ];
      const continuationHash = responsesContinuationPrefixFingerprint(captured.input ?? [], output);
      recordResponsesContextUsage(result, model, identity, captured, output, "transport");
      return { request: captured, result, continuationHash };
    }
    const reference = fixture();
    const goldens = [];
    for (const side of ["baseline", "candidate"]) {
      const { request, result, continuationHash } = await prepare(side, reference);
      goldens.push(
        JSON.stringify({
          request,
          continuationHash,
          replay: Reflect.get(result, "openclawResponsesInputReplay"),
        }),
      );
    }
    assert.equal(goldens[0], goldens[1], "Wire or persisted fingerprint bytes changed");
    console.log(
      JSON.stringify({
        entries: reference.length,
        rounds,
        samples,
        node: process.version,
        payloadBytes: Buffer.byteLength(goldens[0]!),
        sha256: hash("sha256", goldens[0]!),
      }),
    );
    async function run(side: string, messages: Context["messages"]) {
      for (let i = 0; i < rounds; i++) {
        messages.push(
          freezeJsonSnapshot({ role: "user" as const, content: `appended ${i}`, timestamp: i }),
        );
        await prepare(side, messages);
      }
    }
    for (const side of ["baseline", "candidate"]) {
      const messages = fixture();
      await prepare(side, messages);
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
      await run(side, messages);
      const coverage = (await inspector.post("Profiler.takePreciseCoverage")).result;
      await inspector.post("Profiler.stopPreciseCoverage");
      await inspector.post("Profiler.disable");
      console.log(
        JSON.stringify({
          side,
          counts: coverage.flatMap((s) =>
            s.functions
              .filter((f) =>
                [
                  "sha256StableValue",
                  "writeStableStringify",
                  "cloneResponsesInputForPayloadHook",
                ].includes(f.functionName),
              )
              .map((f) => ({ name: f.functionName, count: f.ranges[0]?.count ?? 0 })),
          ),
        }),
      );
    }
    for (let sample = 0; sample < samples; sample++) {
      for (const arm of sample % 2 === 0
        ? ["baseline-A1", "candidate-A1", "baseline-A2", "candidate-A2"]
        : ["candidate-A2", "baseline-A2", "candidate-A1", "baseline-A1"]) {
        const side = arm.split("-")[0]!;
        const timing = fixture();
        await prepare(side, timing);
        gc();
        const cpu0 = process.cpuUsage(),
          t0 = performance.now();
        await run(side, timing);
        const wallMs = performance.now() - t0,
          cpu = process.cpuUsage(cpu0);
        const allocation = fixture();
        await prepare(side, allocation);
        gc();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        await run(side, allocation);
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        console.log(
          JSON.stringify({
            sample,
            arm,
            cpuUs: (cpu.user + cpu.system) / rounds,
            wallUs: (wallMs * 1000) / rounds,
            allocationBytes: profile.samples.reduce((sum, s) => sum + s.size, 0) / rounds,
            load: loadavg(),
          }),
        );
      }
    }
  } finally {
    inspector.disconnect();
  }
});
