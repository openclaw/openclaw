/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/responses-reasoning-state.ts
 *   --baseline packages/ai/src/transports/.reasoning-state-baseline.ts [--rounds 20]
 * Preserve the original reasoning-state module beside its owner before editing.
 * Five counterbalanced A/B/A/A samples; timing and GC-inclusive allocation are separate.
 * 48 nested tool schemas, four interleaved sessions, five growing continued turns,
 * 200/2,000 starting history items. Both arms use identical prepared object identities;
 * warm fixtures and shared SHA checkpoints precede sampling.
 * Accept identical persisted state and continuation decisions, >=10% lower owner
 * allocation and no CPU regression. Composed turns include continuation resolution;
 * neither measurement includes network, Gateway, request encoding or commit accounting.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { configureAiTransportHost } from "../../packages/ai/src/host.js";
import {
  resolveResponsesContinuationRequest,
  type ResponsesContinuationRequest,
  type ResponsesContinuationState,
} from "../../packages/ai/src/transports/openai-responses-continuation.js";
import { readResponsesInputReplayState } from "../../packages/ai/src/transports/openai-responses-input-replay.js";
import { supportsResponsesReasoningUpdate } from "../../packages/ai/src/transports/openai-responses-reasoning-update.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../src/shared/immutable-data.js";

const { values } = parseArgs({
  options: { baseline: { type: "string" }, rounds: { type: "string", default: "20" } },
});
assert(values.baseline, "Supply the original reasoning-state module beside its owner");
assert(globalThis.gc, "Use --expose-gc");
const rounds = Number(values.rounds);
assert(Number.isSafeInteger(rounds) && rounds > 0);
const manifest: unknown = JSON.parse(
  readFileSync("extensions/openai/openclaw.plugin.json", "utf8"),
);
assert(isRecord(manifest));
const catalog = normalizeModelCatalog(manifest.modelCatalog, {
  ownedProviders: new Set(["openai"]),
});
const compatible = catalog?.providers?.openai?.models.find((entry) =>
  supportsResponsesReasoningUpdate({ model: entry.id, reasoning: { effort: "low" }, input: [] }),
);
assert(compatible, "Expected a registered model supporting reasoning controls");
const model: Model = {
  id: compatible.id,
  name: "Synthetic",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://provider.invalid/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
configureAiTransportHost({ immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData } });
type RecordState =
  typeof import("../../packages/ai/src/transports/openai-responses-reasoning-state.js").recordResponsesReasoningState;
const paths = {
  baseline: resolve(values.baseline),
  candidate: resolve("packages/ai/src/transports/openai-responses-reasoning-state.ts"),
};
const owners: Record<string, RecordState> = {};
for (const [side, path] of Object.entries(paths)) {
  owners[side] = (await import(pathToFileURL(path).href)).recordResponsesReasoningState;
}
const tools = freezeJsonSnapshot(
  Array.from({ length: 48 }, (_, tool) => ({
    type: "function",
    name: `synthetic_tool_${tool}`,
    description: "Search and update a synthetic workspace record. ".repeat(8),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "A precise search expression for the requested record.",
        },
        options: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 16 }, (_field, field) => [
              `field_${field}`,
              {
                type: "array",
                description: "Synthetic filter values with documented matching semantics. ".repeat(
                  4,
                ),
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, enabled: { type: "boolean" } },
                  required: ["name"],
                },
              },
            ]),
          ),
        },
      },
    },
  })),
);
const assistant = (): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  stopReason: "stop",
  timestamp: 0,
  usage: {
    input: 10,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 11,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
type Input = NonNullable<ResponsesContinuationRequest["input"]>;
function fixture(items: number) {
  const sessions = Array.from({ length: 4 }, (_, session) => {
    let input: Input = [];
    for (let index = 0; index < items / 4; index++) {
      input.push(
        ...freezeJsonSnapshot([
          {
            type: "message" as const,
            role: "user" as const,
            content: `question ${session}/${index} ${"q".repeat(2048)}`,
          },
          {
            type: "function_call" as const,
            call_id: `call_${session}_${index}`,
            name: "synthetic_tool_0",
            arguments: '{"query":"fixture"}',
          },
          {
            type: "function_call_output" as const,
            call_id: `call_${session}_${index}`,
            output: "result ".repeat(600),
          },
          {
            type: "message" as const,
            role: "assistant" as const,
            id: `msg_history_${session}_${index}`,
            status: "completed" as const,
            content: [
              { type: "output_text" as const, text: "answer ".repeat(300), annotations: [] },
            ],
          },
        ]),
      );
    }
    input[0] = freezeJsonSnapshot({ type: "configuration_update", reasoning: { effort: "low" } });
    const response = (turn: number) =>
      freezeJsonSnapshot([
        {
          type: "message",
          id: `msg_${session}_${turn}`,
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "completed synthetic turn",
              annotations: [],
              logprobs: [],
            },
          ],
        },
      ] satisfies ResponsesContinuationState["lastResponseItems"]);
    let previousOutput = response(-1);
    const frames = [];
    for (let turn = 0; turn < 5; turn++) {
      const previous: ResponsesContinuationRequest = {
        model: model.id,
        reasoning: { effort: "low" },
        tools,
        instructions: "Stable synthetic instructions.",
        input,
      };
      input = input.slice();
      input.push(
        ...previousOutput,
        freezeJsonSnapshot({ type: "message", role: "user", content: `continue ${turn}` }),
      );
      const output = response(turn);
      frames.push({
        state: {
          lastRequest: previous,
          lastResponseId: `resp_${session}_${turn}`,
          lastResponseItems: previousOutput,
        },
        request: { ...previous, input },
        output,
        message: assistant(),
      });
      previousOutput = output;
    }
    return frames;
  });
  return Array.from({ length: 5 }, (_, turn) => sessions.map((session) => session[turn]!)).flat();
}
const inspector = new Session();
inspector.connect();
try {
  console.log(
    JSON.stringify({
      node: process.version,
      rounds,
      callsPerSample: rounds * 20,
      tools: tools.length,
      toolSchemaBytes: Buffer.byteLength(JSON.stringify(tools)),
      ownerSha256: Object.fromEntries(
        Object.entries(paths).map(([side, path]) => [side, hash("sha256", readFileSync(path))]),
      ),
    }),
  );
  for (const items of [200, 2000]) {
    const frames = fixture(items);
    const serialized = () =>
      JSON.stringify(frames.map((frame) => readResponsesInputReplayState(frame.message)));
    const run = (side: "baseline" | "candidate", composed: boolean, repeats: number) => {
      for (let repeat = 0; repeat < repeats; repeat++) {
        for (const frame of frames) {
          if (composed) {
            const resolved = resolveResponsesContinuationRequest(frame.state, frame.request);
            assert.equal(resolved.continuationStatus, "continued");
            assert.equal(resolved.request.input?.length, 1);
          }
          owners[side]!(frame.message, model, undefined, frame.request, frame.output);
        }
      }
    };
    let expected: string | undefined;
    for (const side of ["baseline", "candidate"] as const) {
      run(side, true, 10);
      for (const frame of frames) {
        const reasoning = readResponsesInputReplayState(frame.message)?.reasoning;
        assert(
          isRecord(reasoning) && typeof reasoning.prefixHash === "string",
          "reasoning recording was skipped",
        );
        assert.equal(reasoning.inputLength, frame.request.input.length);
        assert(Array.isArray(reasoning.controls) && reasoning.controls.length === 1);
      }
      if (side === "baseline") {
        expected = serialized();
      } else {
        assert(serialized() === expected, "persisted replay state differs");
      }
    }
    for (let sample = 0; sample < 5; sample++) {
      const labels =
        sample % 2
          ? ["candidate-A2", "baseline-A2", "candidate-A1", "baseline-A1"]
          : ["baseline-A1", "candidate-A1", "baseline-A2", "candidate-A2"];
      for (const label of labels) {
        const side = label.startsWith("baseline") ? "baseline" : "candidate";
        for (const composed of [false, true]) {
          globalThis.gc();
          const cpuStart = process.threadCpuUsage(),
            start = performance.now();
          run(side, composed, rounds);
          const wallMs = performance.now() - start,
            cpu = process.threadCpuUsage(cpuStart);
          globalThis.gc();
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          run(side, composed, rounds);
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          assert(serialized() === expected, "replay state changed during measurement");
          console.log(
            JSON.stringify({
              items,
              sample,
              label,
              flow: composed ? "continued-turn" : "reasoning-state",
              calls: rounds * 20,
              cpuUsPerTurn: (cpu.user + cpu.system) / (rounds * 20),
              wallUsPerTurn: (wallMs * 1000) / (rounds * 20),
              sampledBytesPerTurn:
                profile.samples.reduce((sum, allocation) => sum + allocation.size, 0) /
                (rounds * 20),
              load: loadavg(),
            }),
          );
        }
      }
    }
  }
} finally {
  inspector.disconnect();
}
