/**
 * Run on each revision, counterbalancing order, in separate processes:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/system-prompt-request-measure.ts
 *   --mode timing --sessions 65 --iterations 3000
 * Repeat with --mode allocation. Use --sessions 1 as the no-eviction control.
 * Add --boundary to include the provider plugin's cache-boundary transform.
 * Add --fresh for a new Agent per operation in concurrent batches of --sessions.
 * Fresh mode prebuilds prompt strings and checks exact instructions each request.
 * Each operation uses a real Agent, a 64-KiB marked prompt and 40 tools, builds
 * two Responses requests, and executes one mock tool. History resets between
 * operations; by default the Agent survives across Agent.prompt calls.
 * Fresh mode keeps only prompt strings and tool definitions between operations.
 * Setup/warmup are excluded. Allocation includes collected objects; CPU and GC
 * decisions use the untraced timing pass. This measures the owner path, not a
 * Gateway or network latency. No credentials or model requests are used.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { Agent } from "../../packages/agent-core/src/agent.js";
import type { AgentTool, StreamFn } from "../../packages/agent-core/src/types.js";
import { buildOpenAIResponsesParams } from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import { createAssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../packages/ai/src/utils/system-prompt-cache-boundary.js";
import * as promptBoundary from "../../packages/ai/src/utils/system-prompt-cache-boundary.js";
import type { AssistantMessage, Model } from "../../packages/llm-core/src/types.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    sessions: { type: "string", default: "65" },
    iterations: { type: "string", default: "3000" },
    boundary: { type: "boolean", default: false },
    fresh: { type: "boolean", default: false },
  },
});
const mode = values.mode;
const sessions = Number(values.sessions);
const iterations = Number(values.iterations);
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(sessions) && sessions > 0);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Use --expose-gc");
const model: Model = {
  id: "synthetic-model",
  name: "Synthetic model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  compat: { supportsInstructions: true },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 256,
};
const tools: AgentTool[] = Array.from({ length: 40 }, (_, index) => ({
  name: `synthetic_${index}`,
  label: `Synthetic ${index}`,
  description: "Read synthetic state.",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "synthetic result" }], details: {} }),
}));
let requests = 0;
let characters = 0;
const streamForPrompt =
  (expected?: string): StreamFn =>
  (_model, context) => {
    const params = buildOpenAIResponsesParams(model, context, undefined);
    if (expected !== undefined) {
      assert.equal(params.instructions, expected);
    }
    characters += params.instructions?.length ?? 0;
    requests++;
    const done = context.messages.at(-1)?.role === "toolResult";
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: done
        ? [{ type: "text", text: "done" }]
        : [{ type: "toolCall", id: "call", name: "synthetic_0", arguments: {} }],
      stopReason: done ? "stop" : "toolUse",
      timestamp: 1,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    queueMicrotask(() => {
      stream.push({ type: "done", reason: done ? "stop" : "toolUse", message });
      stream.end();
    });
    return stream;
  };
const prompts = Array.from(
  { length: sessions },
  (_, index) =>
    `## Synthetic session ${index}\n${"Keep exact prompt bytes, including 🦞.\n".repeat(1800).slice(0, 65536)}${SYSTEM_PROMPT_CACHE_BOUNDARY}Runtime facts.`,
);
const expectedInstructions = values.fresh
  ? prompts.map((prompt) => prompt.replace(SYSTEM_PROMPT_CACHE_BOUNDARY, "\n"))
  : [];
const retainedStreamFn = streamForPrompt();
function createAgent(index: number) {
  const streamFn = values.fresh
    ? streamForPrompt(expectedInstructions[index % sessions])
    : retainedStreamFn;
  // Older revisions expose only the string operation used by the original plugin wrapper.
  const stripBoundary = values.boundary
    ? (promptBoundary.createSystemPromptCacheBoundaryStripper?.() ??
      ((context: Parameters<StreamFn>[1]) => ({
        ...context,
        systemPrompt: promptBoundary.stripSystemPromptCacheBoundary(context.systemPrompt ?? ""),
      })))
    : undefined;
  return new Agent({
    initialState: {
      model,
      tools,
      systemPrompt: prompts[index % sessions]!,
    },
    streamFn: stripBoundary
      ? (activeModel, context, options) => streamFn(activeModel, stripBoundary(context), options)
      : streamFn,
  });
}
const agents = values.fresh
  ? []
  : Array.from({ length: sessions }, (_, index) => createAgent(index));
async function run(count: number) {
  if (values.fresh) {
    for (let offset = 0; offset < count; offset += sessions) {
      await Promise.all(
        Array.from({ length: Math.min(sessions, count - offset) }, async (_, i) => {
          const agent = createAgent(offset + i);
          await agent.prompt("Read synthetic state.");
          assert.equal(agent.state.errorMessage, undefined);
        }),
      );
    }
    return;
  }
  for (let i = 0; i < count; i++) {
    const agent = agents[i % agents.length]!;
    agent.state.messages = [];
    await agent.prompt("Read synthetic state.");
    assert.equal(agent.state.errorMessage, undefined);
  }
}
await run(sessions * 2);
global.gc();
await setImmediate();
await setImmediate();
const gc: number[] = [];
const gcKinds: Record<string, { count: number; ms: number; maxMs: number }> = {};
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.push(entry.duration);
    const kind = String((entry as typeof entry & { detail: { kind: number } }).detail.kind);
    const aggregate = (gcKinds[kind] ??= { count: 0, ms: 0, maxMs: 0 });
    aggregate.count++;
    aggregate.ms += entry.duration;
    aggregate.maxMs = Math.max(aggregate.maxMs, entry.duration);
  }
});
observer.observe({ entryTypes: ["gc"] });
const inspector = new Session();
try {
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  requests = 0;
  characters = 0;
  const loadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.cpuUsage();
  const start = performance.now();
  await run(iterations);
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  await setImmediate();
  await setImmediate();
  observer.disconnect();
  const sampledBytes =
    mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
          (sum, sample) => sum + sample.size,
          0,
        )
      : undefined;
  assert.equal(requests, iterations * 2);
  assert(characters > requests * 65536);
  global.gc();
  console.log(
    JSON.stringify({
      mode,
      sessions,
      boundary: values.boundary,
      iterations,
      requests,
      characters,
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      sampledBytes,
      gcMs: gc.reduce((sum, value) => sum + value, 0),
      gcCount: gc.length,
      gcKinds,
      fresh: values.fresh,
      maxGcMs: Math.max(0, ...gc),
      memoryBefore,
      memoryAfter,
      memoryAfterGc: process.memoryUsage(),
      loadBefore,
      loadAfter: loadavg(),
      node: process.version,
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
}
