/**
 * Measure the installed attempt stream guards with synthetic provider deltas.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/attempt-stream-repair-measure.ts
 *   --mode timing --turns 64 --deltas 256 --concurrency 8
 * Repeat with --mode allocation; interleave baseline/candidate at least five times.
 * --owner selects an attempt-stream.ts source snapshot with unchanged relative imports.
 * No network, Gateway, transcript writes, or credentials. Repairs are absent, as in
 * ordinary streaming; pending-repair semantics are covered by stream-custody tests.
 * Acceptance: lower allocation/CPU per 1,000 deltas, identical event order/content.
 * This owner measurement does not establish whole-Gateway latency or throughput.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { notifyLlmRequestActivity } from "@openclaw/ai/internal/runtime";
import { createAssistantMessageEventStream } from "@openclaw/llm-core/event-stream";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@openclaw/llm-core/types";
import type { EmbeddedAttemptExecutionPhaseInput } from "../../src/agents/embedded-agent-runner/run/attempt-execution-types.js";
import type { installEmbeddedAttemptStreamGuards } from "../../src/agents/embedded-agent-runner/run/attempt-stream.js";
import type { StreamFn } from "../../src/agents/runtime/index.js";
import { createDiagnosticTraceContext } from "../../src/infra/diagnostic-trace-context.js";
import { createDiagnosticEmbeddedRunOwner } from "../../src/logging/diagnostic-run-activity.js";
import { createStageTimingTracker } from "../../src/shared/stage-timing.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    owner: { type: "string", default: "src/agents/embedded-agent-runner/run/attempt-stream.ts" },
    turns: { type: "string", default: "64" },
    deltas: { type: "string", default: "256" },
    concurrency: { type: "string", default: "8" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
const count = (label: "turns" | "deltas" | "concurrency", fallback: number) =>
  parseStrictIntegerOption({ raw: values[label], fallback, min: 1, label });
const turns = count("turns", 64);
const deltas = count("deltas", 256);
const concurrency = count("concurrency", 8);
const owner: { installEmbeddedAttemptStreamGuards: typeof installEmbeddedAttemptStreamGuards } =
  await import(pathToFileURL(resolve(values.owner)).href);
const model: Model = {
  id: "synthetic-stream",
  name: "Synthetic stream",
  api: "openai-responses",
  provider: "synthetic",
  baseUrl: "http://127.0.0.1:49999",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};
const noop = () => {};

async function run(turnCount: number) {
  let nextTurn = 0;
  let checksum = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextTurn < turnCount) {
        const turn = nextTurn++;
        const source = createAssistantMessageEventStream();
        let signal: AbortSignal | undefined;
        const provider: StreamFn = (_model, _context, options) => {
          signal = options?.signal;
          return source;
        };
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: "toolCall", id: "call-synthetic", name: "read", arguments: {} }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        };
        const activeSession = {
          agent: { streamFn: provider },
          sessionId: `synthetic-${turn}`,
          messages: [],
        };
        const attempt = {
          config: {},
          model,
          modelId: model.id,
          provider: model.provider,
          runId: `synthetic-${turn}`,
          sessionId: activeSession.sessionId,
          sessionKey: `agent:synthetic:${turn}`,
          timeoutMs: 120_000,
        };
        // Supply preparation facts only, matching the stream-custody integration fixture.
        // No repair is triggered, so this workload never accesses a session manager.
        const input = {
          attempt,
          runAbortController: new AbortController(),
          prepared: {
            sessionRuntime: {
              agentSession: { activeSession },
              contextGuards: { checkMidTurnPrecheck: noop, recordCacheTouch: noop },
              isOpenAIResponsesApi: true,
              state: { systemPromptText: "Synthetic prompt" },
              transcriptPolicy: {},
              transport: { effectiveAgentTransport: "sse" },
            },
            toolCatalog: {
              toolSearchRunPlan: {
                liveAllowedToolNames: new Set(["read"]),
                replayAllowedToolNames: new Set(["read"]),
              },
            },
          },
          setup: {
            sessionAgentId: "synthetic",
            prepStages: createStageTimingTracker(() => 0),
            emitPrepStageSummary: noop,
          },
          diagnostics: { runTrace: createDiagnosticTraceContext() },
          lifecycle: { readYieldState: () => ({ yieldDetected: false }) },
        } as unknown as EmbeddedAttemptExecutionPhaseInput;
        owner.installEmbeddedAttemptStreamGuards(input, {
          onRejectedProviderReplayRepaired: () => assert.fail("unexpected repair"),
          onIdleTimeout: (error) => {
            throw error;
          },
          diagnosticOwner: createDiagnosticEmbeddedRunOwner(attempt),
        });
        const stream = await activeSession.agent.streamFn(
          model,
          { messages: [] },
          { signal: input.runAbortController.signal },
        );
        const iterator = stream[Symbol.asyncIterator]();
        try {
          for (let index = 0; index < deltas; index++) {
            const event: AssistantMessageEvent =
              index % 8 === 7
                ? { type: "toolcall_delta", contentIndex: 0, delta: " ", partial: message }
                : { type: "text_delta", contentIndex: 0, delta: String(index % 10) };
            const pending = iterator.next();
            notifyLlmRequestActivity(signal);
            source.push(event);
            const result = await pending;
            assert(!result.done && result.value === event, "event identity/order changed");
            checksum += event.type === "toolcall_delta" ? 2 : 1;
          }
          source.push({ type: "done", reason: "toolUse", message });
          source.end(message);
          assert.equal((await iterator.next()).value?.type, "done");
          assert((await iterator.next()).done);
          assert.equal(await stream.result(), message);
        } finally {
          source.end(message);
          await iterator.return?.();
        }
      }
    }),
  );
  assert.equal(checksum, turnCount * (deltas + Math.floor(deltas / 8)));
  return checksum;
}

await run(Math.min(turns, 8));
globalThis.gc?.();
const inspector = values.mode === "allocation" ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16_384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const cpuStart = process.cpuUsage();
const threadStart = process.threadCpuUsage();
const started = performance.now();
const checksum = await run(turns);
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(cpuStart);
const thread = process.threadCpuUsage(threadStart);
let sampledBytes: number | undefined;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    mode: values.mode,
    owner: values.owner,
    turns,
    deltas,
    concurrency,
    events: turns * deltas,
    checksum,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    mainThreadCpuMs: (thread.user + thread.system) / 1000,
    sampledBytes,
    bytesPer1000Deltas:
      sampledBytes === undefined ? undefined : (sampledBytes * 1000) / (turns * deltas),
    rssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  }),
);
