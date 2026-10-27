/**
 * Synthetic event-boundary proof, not a live Gateway/provider benchmark.
 * Run in an isolated HOME/state/tmp with:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/terminal-assistant-snapshot-measure.ts
 * Pass --counts for an untimed diagnostic, --short for the short-answer control,
 * --text-only for a long reply without reasoning, or --cpu for separate thread-CPU diagnostics.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { subscribeEmbeddedAgentSession } from "../../src/agents/embedded-agent-subscribe.js";
import { sessionManagerReadTranscriptStart } from "../../src/agents/sessions/session-manager-current-turn.js";
import { makeZeroUsageSnapshot } from "../../src/agents/usage.js";
import { readAgentAssistantSource } from "../../src/infra/agent-events.js";
import type { AssistantMessage } from "../../src/llm/types.js";

const short = process.argv.includes("--short");
const countWork = process.argv.includes("--counts");
const textOnly = process.argv.includes("--text-only");
const countCpu = process.argv.includes("--cpu");
const activeTurns = 24;
const thinkingChars = textOnly ? 0 : short ? 128 : 128 * 1024;
const finalChars = textOnly ? 128 * 1024 : short ? 64 : 8 * 1024;
const memoryKeys = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"] as const;
const nativeClone = globalThis.structuredClone;
assert(globalThis.gc, "Run with --expose-gc to measure retained heap");
const work = { calls: 0, stringBytes: 0, thinkingBytes: 0, textBytes: 0 };
function stringBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === "string") {
    return Buffer.byteLength(value);
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return 0;
  }
  seen.add(value);
  return Object.values(value).reduce<number>((sum, item) => sum + stringBytes(item, seen), 0);
}
if (countWork) {
  globalThis.structuredClone = (value, options) => {
    work.calls += 1;
    work.stringBytes += stringBytes(value);
    if (isRecord(value) && value.role === "assistant" && Array.isArray(value.content)) {
      for (const block of value.content) {
        if (block.type === "thinking") {
          work.thinkingBytes += Buffer.byteLength(block.thinking);
        }
        if (block.type === "text") {
          work.textBytes += Buffer.byteLength(block.text);
        }
      }
    }
    return nativeClone(value, options);
  };
}
function text(seed: string, size: number) {
  const rows: string[] = [];
  let length = 0;
  for (let index = 0; length < size; index += 1) {
    const row =
      seed + ":" + index + " Compare the intermediate result and preserve the final reply.\n";
    rows.push(row);
    length += row.length;
  }
  return rows.join("").slice(0, size);
}
function assistant(index: number, tool = false): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "fixture-model",
    timestamp: index,
    responseId: "response-" + index,
    stopReason: tool ? "toolUse" : "stop",
    usage: { ...makeZeroUsageSnapshot(), input: 100, output: 50, totalTokens: 150 },
    providerReplay: {
      v: 1,
      type: "fixture",
      data: "opaque-" + index,
      provider: "openai",
      api: "openai-responses",
      model: "fixture-model",
    },
    content: tool
      ? [
          {
            type: "thinking",
            thinking: text("tool-thinking-" + index, thinkingChars / 4),
            thinkingSignature: "tool-signature-" + index,
          },
          {
            type: "toolCall",
            id: "lookup-" + index,
            name: "lookup",
            arguments: { query: text("argument-" + index, finalChars), nested: { retain: true } },
          },
        ]
      : [
          {
            type: "thinking",
            thinking: text("final-thinking-" + index, thinkingChars),
            thinkingSignature: "final-signature-" + index,
          },
          {
            type: "text",
            text:
              "[[reply_to:fixture]][[audio_as_voice]][[tts:text]]Speak fixture.[[/tts:text]]" +
              text("final-" + index, finalChars) +
              "\nMEDIA:https://example.test/fixture.png",
            textSignature: JSON.stringify({ v: 1, id: "answer-" + index, phase: "final_answer" }),
          },
        ],
  };
}
function harness(index: number) {
  let listener: ((event: unknown) => unknown) | undefined;
  const session = {
    sessionManager: { [sessionManagerReadTranscriptStart]: () => null },
    subscribe: (callback: (event: unknown) => unknown) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"];
  const subscription = subscribeEmbeddedAgentSession({ session, runId: "snapshot-probe-" + index });
  function emit(message: AssistantMessage, stream: boolean) {
    listener?.({ type: "message_start", message });
    if (stream) {
      for (const [contentIndex, block] of message.content.entries()) {
        if (block.type !== "text") {
          continue;
        }
        for (let offset = 0; offset < block.text.length; offset += 2048) {
          listener?.({
            type: "message_update",
            message,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex,
              delta: block.text.slice(offset, offset + 2048),
              partial: message,
            },
          });
        }
      }
    }
    listener?.({ type: "message_end", message });
  }
  return { subscription, emit };
}
async function collect() {
  globalThis.gc?.();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  globalThis.gc?.();
}
const digest = createHash("sha256");
const timings: number[] = [];
const threadCpuMicros: number[] = [];
const sources = Array.from({ length: activeTurns }, (_, index) => ({
  tool: assistant(index, true),
  final: assistant(index),
}));
for (let index = 0; index < 3; index += 1) {
  const warm = harness(-index - 1);
  warm.emit(assistant(-index - 1), true);
  await warm.subscription.waitForPendingEvents();
  warm.subscription.unsubscribe();
}
Object.assign(work, { calls: 0, stringBytes: 0, thinkingBytes: 0, textBytes: 0 });
await collect();
const before = process.memoryUsage();
const held: ReturnType<typeof harness>[] = [];
const peak = { ...before };
for (const [index, source] of sources.entries()) {
  const h = harness(index);
  held.push(h);
  const cpuStart = countCpu ? process.threadCpuUsage() : undefined;
  const start = performance.now();
  h.emit(source.tool, false);
  h.emit(source.final, true);
  await h.subscription.waitForPendingEvents();
  timings.push(performance.now() - start);
  if (cpuStart) {
    const cpu = process.threadCpuUsage(cpuStart);
    threadCpuMicros.push(cpu.user + cpu.system);
  }
  const memory = process.memoryUsage();
  for (const key of memoryKeys) {
    peak[key] = Math.max(peak[key], memory[key]);
  }
}
await collect();
const retained = process.memoryUsage();
for (const [index, h] of held.entries()) {
  const source = sources[index];
  assert(source);
  const completed = h.subscription.getCurrentAttemptAssistant();
  assert(completed);
  assert.notEqual(completed, source.final);
  assert.equal(completed.openclawDelivery?.replyToId, "fixture");
  assert.equal(completed.openclawDelivery?.audioAsVoice, true);
  assert.equal(completed.openclawDelivery?.tts?.text, "Speak fixture.");
  const sourceReceipt = readAgentAssistantSource(source.final);
  assert(sourceReceipt);
  assert.equal(readAgentAssistantSource(completed), sourceReceipt);
  digest.update(JSON.stringify(completed));
  source.final.content = [{ type: "text", text: "transcript projection changed" }];
  source.final.usage.cost.total = 999;
  const silent = { ...assistant(index), content: [{ type: "text" as const, text: "NO_REPLY" }] };
  h.emit(silent, false);
  await h.subscription.waitForPendingEvents();
  const kept = h.subscription.getKeptAnswer();
  assert(kept);
  assert.equal(kept.assistant.content[0]?.type, "thinking");
  assert.equal(kept.assistant.usage.cost.total, 0);
  assert.equal(kept.assistant.openclawDelivery?.tts?.text, "Speak fixture.");
  assert.equal(readAgentAssistantSource(kept.assistant), readAgentAssistantSource(completed));
  digest.update(JSON.stringify(kept));
}
await collect();
const kept = process.memoryUsage();
for (const h of held) {
  h.subscription.unsubscribe();
}
globalThis.structuredClone = nativeClone;
const wallByTurnMs = countCpu ? timings.slice() : undefined;
timings.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    label: process.argv.find((arg) => arg.startsWith("--label="))?.slice(8),
    node: process.version,
    load: os.loadavg(),
    mode: textOnly ? "text-only" : short ? "short" : "long",
    threadCpuMicros,
    wallByTurnMs,
    activeTurns,
    thinkingChars,
    finalChars,
    countWork,
    work,
    before,
    peak,
    retained,
    kept,
    retainedDelta: Object.fromEntries(memoryKeys.map((key) => [key, retained[key] - before[key]])),
    latencyMs: {
      min: timings[0],
      median: timings[Math.floor(timings.length / 2)],
      p95: timings[Math.ceil(timings.length * 0.95) - 1],
      max: timings.at(-1),
    },
    behaviorDigest: digest.digest("hex"),
  }),
);
