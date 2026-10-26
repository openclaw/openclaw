/**
 * Owner microbenchmark for per-delta idle-watchdog work (not a Gateway load test).
 * Run the same script in each revision, interleaving at least five short arms:
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/stream-idle-watchdog.ts --mode timing
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/stream-idle-watchdog.ts --mode allocation
 * --owner accepts an equivalent owner module for comparisons without a build.
 * Synthetic concurrent streams notify real provider activity and alternate text
 * and tool-call fragments; all events must preserve identity and order. Timing
 * excludes allocation profiling. Acceptance: fewer allocations/CPU per event,
 * unchanged event checksum; this does not establish whole-Gateway latency.
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
import type { streamWithIdleTimeout } from "../../src/agents/embedded-agent-runner/run/llm-idle-timeout.js";
import type { StreamFn } from "../../src/agents/runtime/index.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    owner: { type: "string", default: "src/agents/embedded-agent-runner/run/llm-idle-timeout.ts" },
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
const owner: { streamWithIdleTimeout: typeof streamWithIdleTimeout } = await import(
  pathToFileURL(resolve(values.owner)).href
);
const model: Model = {
  id: "synthetic-stream",
  name: "Synthetic stream",
  api: "openai-completions",
  provider: "synthetic",
  baseUrl: "http://127.0.0.1:49999",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 4096,
};
const message: AssistantMessage = {
  role: "assistant",
  content: [{ type: "toolCall", id: "synthetic-read", name: "read", arguments: {} }],
  api: model.api,
  provider: model.provider,
  model: model.id,
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
const events: AssistantMessageEvent[] = Array.from({ length: deltas }, (_, index) =>
  index % 8 === 7
    ? { type: "toolcall_delta", contentIndex: 0, delta: " ", partial: message }
    : { type: "text_delta", contentIndex: 0, delta: String(index % 10) },
);

async function run(turnCount: number) {
  let checksum = 0;
  let nextTurn = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextTurn++ < turnCount) {
        const source = createAssistantMessageEventStream();
        const caller = new AbortController();
        let signal: AbortSignal | undefined;
        const provider: StreamFn = (_model, _context, options) => {
          signal = options?.signal;
          return source;
        };
        const stream = await owner.streamWithIdleTimeout(provider, 120_000)(
          model,
          { messages: [] },
          { signal: caller.signal },
        );
        const iterator = stream[Symbol.asyncIterator]();
        for (const event of events) {
          const pending = iterator.next();
          notifyLlmRequestActivity(signal);
          source.push(event);
          const result = await pending;
          assert(result.value === event && !result.done, "stream changed event identity/order");
          checksum += event.type === "toolcall_delta" ? 2 : 1;
        }
        source.end(message);
        assert((await iterator.next()).done, "stream did not finish");
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
const beforeLoad = loadavg();
const startCpu = process.cpuUsage();
const startThreadCpu = process.threadCpuUsage();
const started = performance.now();
const checksum = await run(turns);
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(startCpu);
const threadCpu = process.threadCpuUsage(startThreadCpu);
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
    mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
    sampledBytes,
    sampledBytesPerEvent: sampledBytes === undefined ? undefined : sampledBytes / (turns * deltas),
    rssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
    hostLoadBefore: beforeLoad,
    hostLoadAfter: loadavg(),
  }),
);
