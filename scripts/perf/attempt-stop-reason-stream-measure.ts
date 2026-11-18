/**
 * Stop-reason stream continuation workload (Node, no network or credentials).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/attempt-stop-reason-stream-measure.ts
 *   --mode timing --turns 128 --events 1000
 * Repeat with --mode allocation; use five alternating base/candidate pairs.
 * --owner selects a source snapshot whose relative imports still resolve.
 * Eight concurrent streams alternate text/tool deltas and verify result identity.
 * Acceptance: reduce allocation per 1,000 events without a material CPU regression.
 * Allocation passes include collected objects; only untraced passes supply CPU.
 * This isolates the decorator, not whole-Gateway latency or provider throughput.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@openclaw/llm-core/types";
import type { StreamFn } from "../../src/agents/runtime/index.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    owner: {
      type: "string",
      default: "src/agents/embedded-agent-runner/run/attempt-stop-reason-recovery.ts",
    },
    mode: { type: "string", default: "timing" },
    turns: { type: "string", default: "128" },
    events: { type: "string", default: "1000" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
assert(global.gc, "Run with --expose-gc");
const count = (name: "turns" | "events") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const turns = count("turns");
const events = count("events");
const {
  wrapStreamFnHandleSensitiveStopReason: wrap,
}: typeof import("../../src/agents/embedded-agent-runner/run/attempt-stop-reason-recovery.js") =
  await import(pathToFileURL(resolve(values.owner)).href);
const model: Model = {
  id: "synthetic-stream",
  name: "Synthetic stream",
  api: "anthropic-messages",
  provider: "synthetic",
  baseUrl: "http://127.0.0.1:49999",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};
const message: AssistantMessage = {
  role: "assistant",
  api: model.api,
  provider: model.provider,
  model: model.id,
  content: [{ type: "toolCall", id: "synthetic-call", name: "read", arguments: {} }],
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
const results: IteratorResult<AssistantMessageEvent>[] = ["text_delta", "toolcall_delta"].map(
  (type) => ({
    done: false,
    value:
      type === "text_delta"
        ? { type, contentIndex: 0, delta: "x", partial: message }
        : { type: "toolcall_delta", contentIndex: 0, delta: " ", partial: message },
  }),
);
const end: IteratorResult<AssistantMessageEvent> = { done: true, value: undefined };

async function run(turnCount: number) {
  await Promise.all(
    Array.from({ length: 8 }, async (_, lane) => {
      for (let turn = lane; turn < turnCount; turn += 8) {
        let index = 0;
        const source: Awaited<ReturnType<StreamFn>> = {
          result: async () => message,
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve(index < events ? results[index++ % 2]! : end),
          }),
        };
        const stream = await wrap(() => source)(model, { messages: [] }, undefined);
        const iterator = stream[Symbol.asyncIterator]();
        for (let event = 0; event < events; event++) {
          assert.equal(await iterator.next(), results[event % 2]);
        }
        assert.equal(await iterator.next(), end);
        assert.equal(await stream.result(), message);
      }
    }),
  );
}

await run(Math.min(turns, 16));
global.gc();
const inspector = values.mode === "allocation" ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const start = process.threadCpuUsage();
const time = performance.now();
await run(turns);
const elapsedMs = performance.now() - time;
const cpu = process.threadCpuUsage(start);
let sampledBytes: number | undefined;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((acc, child) => acc + sum(child), 0);
  sampledBytes = sum(profile.head);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    node: process.version,
    owner: values.owner,
    mode: values.mode,
    events: turns * events,
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    elapsedMs,
    sampledBytes,
    bytesPer1000Events:
      sampledBytes === undefined ? undefined : (sampledBytes / turns / events) * 1000,
    ...process.memoryUsage(),
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  }),
);
