/**
 * Synthetic Responses turn loop through conversion, continuation and context-usage owners.
 * Save exact baseline continuation + context-usage modules beside their owners, pointing
 * the latter's continuation import at the former. Run with --baseline <continuation path>
 * --baseline-context <context-usage path> under node --expose-gc --import ./scripts/tsx.mjs.
 * Acceptance: identical decisions, wire deltas and persisted contextUsage; candidate
 * beats both A arms in warm CPU and collected-object allocation, five interleaved samples.
 * Conversion is outside owner timing; no database, network or provider cache-hit claims.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createAiTransportHost, runWithAiTransportHost } from "../../packages/ai/src/host.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
} from "../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import * as candidateContext from "../../packages/ai/src/transports/openai-responses-context-usage.js";
import * as candidate from "../../packages/ai/src/transports/openai-responses-continuation.js";
import { OPENAI_RESPONSES_REASONING_REPLAY_META_KEY } from "../../packages/ai/src/transports/openai-responses-contracts.js";
import { buildOpenAIResponsesParams } from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import { sanitizeResponsesImagePayload } from "../../packages/ai/src/transports/responses-image-payload-sanitizer.js";
import type { AssistantMessage, Context, Model } from "../../packages/llm-core/src/types.js";
import { transformTransportMessages } from "../../src/agents/transport-message-transform.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../src/shared/immutable-data.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    "baseline-context": { type: "string" },
    entries: { type: "string", default: "2000" },
    samples: { type: "string", default: "5" },
  },
});
assert(values.baseline && values["baseline-context"]);
assert(globalThis.gc, "Use --expose-gc");
const entries = parseStrictIntegerOption({
  raw: values.entries,
  label: "entries",
  min: 1,
  fallback: 2000,
});
const samples = parseStrictIntegerOption({
  raw: values.samples,
  label: "samples",
  min: 1,
  fallback: 5,
});
const baseline: typeof candidate = await import(pathToFileURL(resolve(values.baseline)).href);
const baselineContext: typeof candidateContext = await import(
  pathToFileURL(resolve(values["baseline-context"])).href
);
const owners = {
  A1: { ...baseline, ...baselineContext },
  A2: { ...baseline, ...baselineContext },
  B: { ...candidate, ...candidateContext },
};
const sessions = 4;
const turns = 8;
const timingRepeats = 20;
const allocationRepeats = 3;
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
const identity = { sessionId: "synthetic-continuation-equality" };
const responseItem = {
  type: "message" as const,
  id: "msg_synthetic",
  role: "assistant" as const,
  status: "completed" as const,
  content: [{ type: "output_text" as const, text: "Synthetic answer", annotations: [] }],
};
const answer = [{ type: "text" as const, text: "Synthetic answer" }];
function assistant(content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant",
    content,
    provider: model.provider,
    api: model.api,
    model: model.id,
    timestamp: 0,
    stopReason: "stop",
    usage: {
      input: 5,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      contextUsage: { state: "available", promptTokens: 5, totalTokens: 8 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
const host = createAiTransportHost({
  immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
  transformTransportMessages,
});
const inspector = new Session();
inspector.connect();
await runWithAiTransportHost(host, async () => {
  function fixture(mode: string) {
    return Array.from({ length: sessions }, (_fixture, session) => {
      const messages: Context["messages"] = [];
      if (mode !== "plain") {
        const checkpoint = assistant();
        const item = {
          type: "compaction" as const,
          id: "cmp_synthetic",
          encrypted_content: `checkpoint-${session}`,
        };
        const window =
          mode === "window"
            ? Array.from({ length: entries }, (_entry, i) => ({
                type: "message" as const,
                role: "user" as const,
                content: [
                  {
                    type: "input_text" as const,
                    text: `history_${session}_${i} ${"x".repeat(2048)}`,
                  },
                ],
              }))
            : [];
        captureOpenAIResponsesCompaction(
          checkpoint,
          item,
          0,
          model,
          buildOpenAIResponsesReasoningReplayMetadata(model, identity),
          mode === "window" ? [...window, item] : undefined,
        );
        messages.push(freezeJsonSnapshot(checkpoint));
      }
      for (let i = 0; i < (mode === "window" ? 6 : entries); i += 3) {
        messages.push(
          freezeJsonSnapshot({ role: "user", content: `question ${session} ${i}`, timestamp: i }),
          freezeJsonSnapshot(
            assistant([
              {
                type: "thinking",
                thinking: "",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  summary: [],
                  encrypted_content: `ciphertext-${i}`,
                  [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]:
                    buildOpenAIResponsesReasoningReplayMetadata(model, identity),
                }),
              },
              { type: "toolCall", id: `call_${i}`, name: "lookup", arguments: { index: i } },
            ]),
          ),
          freezeJsonSnapshot({
            role: "toolResult",
            toolCallId: `call_${i}`,
            toolName: "lookup",
            content: [{ type: "text", text: `history_${session}_${i} ${"x".repeat(6144)}` }],
            isError: false,
            timestamp: i,
          }),
        );
      }
      const build = () =>
        sanitizeResponsesImagePayload(
          buildOpenAIResponsesParams(
            model,
            { messages, systemPrompt: "Stable synthetic instructions" },
            identity,
          ),
        );
      const initial = build();
      assert(
        initial.input?.some((item) => item.type === "reasoning"),
        "Fixture lost reasoning replay",
      );
      const requests = Array.from({ length: turns }, (_request, turn) => {
        messages.push(freezeJsonSnapshot(assistant(answer)));
        messages.push(
          freezeJsonSnapshot({ role: "user", content: `new suffix ${turn}`, timestamp: turn }),
        );
        return build();
      });
      return { initial, requests };
    });
  }
  type Fixtures = ReturnType<typeof fixture>;
  function run(fixtures: Fixtures, owner: typeof owners.B, collect = false) {
    const records: unknown[] = [];
    let hits = 0;
    for (const current of fixtures) {
      let previous = current.initial;
      owner.responsesContinuationPrefixFingerprint(previous.input ?? []);
      for (const request of current.requests) {
        const resolved = owner.resolveResponsesContinuationRequest(
          {
            lastRequest: previous,
            lastResponseId: "resp_synthetic",
            lastResponseItems: [responseItem],
          },
          request,
        );
        hits += Number(resolved.continuationStatus === "continued");
        const message = assistant(answer);
        owner.recordResponsesContextUsage(
          message,
          model,
          identity,
          request,
          [responseItem],
          "transport",
        );
        if (collect) {
          records.push({
            request: resolved.request,
            status: resolved.continuationStatus,
            replay: Reflect.get(message, "openclawResponsesInputReplay"),
          });
        }
        previous = request;
      }
    }
    return { hits, records };
  }
  console.log(JSON.stringify({ entries, sessions, turns, samples, node: process.version }));
  for (const mode of ["plain", "checkpoint", "window"]) {
    const parity = fixture(mode);
    const expected = run(parity, owners.A1, true);
    assert.deepEqual(run(parity, owners.B, true), expected);
    assert.equal(expected.hits, sessions * turns);
    for (const arm of ["A1", "B"] as const) {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
      run(parity, owners[arm]);
      const coverage = (await inspector.post("Profiler.takePreciseCoverage")).result;
      await inspector.post("Profiler.stopPreciseCoverage");
      await inspector.post("Profiler.disable");
      const counts: Record<string, number> = {};
      for (const script of coverage) {
        for (const fn of script.functions) {
          if (
            ["projectedJsonEqual", "appendPrefixValues", "projectJsonValue"].includes(
              fn.functionName,
            )
          ) {
            counts[fn.functionName] = (counts[fn.functionName] ?? 0) + (fn.ranges[0]?.count ?? 0);
          }
        }
      }
      console.log(JSON.stringify({ kind: "counts", mode, arm, counts }));
      if (arm === "B") {
        assert((counts.projectedJsonEqual ?? 0) < sessions * turns * 30);
      }
    }
    for (let sample = 0; sample < samples; sample++) {
      for (const arm of (sample % 2 ? ["B", "A2", "A1"] : ["A1", "A2", "B"]) as Array<
        keyof typeof owners
      >) {
        const fixtures = fixture(mode);
        run(fixtures, owners[arm]);
        globalThis.gc!();
        const cpu0 = process.cpuUsage();
        const start = performance.now();
        let hits = 0;
        for (let repeat = 0; repeat < timingRepeats; repeat++) {
          hits += run(fixtures, owners[arm]).hits;
        }
        const wallUs = (performance.now() - start) * 1000;
        const cpu = process.cpuUsage(cpu0);
        globalThis.gc!();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        for (let repeat = 0; repeat < allocationRepeats; repeat++) {
          run(fixtures, owners[arm]);
        }
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        const calls = sessions * turns * timingRepeats;
        console.log(
          JSON.stringify({
            kind: "sample",
            mode,
            arm,
            sample,
            hits,
            calls,
            cpuUs: (cpu.user + cpu.system) / calls,
            wallUs: wallUs / calls,
            allocationBytes:
              profile.samples.reduce((sum, allocation) => sum + allocation.size, 0) /
              (sessions * turns * allocationRepeats),
            load: loadavg(),
          }),
        );
      }
    }
  }
});
inspector.disconnect();
