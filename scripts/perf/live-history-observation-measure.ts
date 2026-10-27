// Run with node --expose-gc --import ./scripts/tsx.mjs <this file> --rounds 3000.
// --append-owner /absolute/base.ts selects the baseline persistence owner.
// Alternate base/candidate processes; use --allocation for a separate sampled pass.
// Measures 40 retained messages (20 reasoning/tool-call replies, 20 tool results)
// after real guarded session append. No Gateway, disk transcript, or provider I/O.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { beginPromptCacheObservation } from "../../src/agents/embedded-agent-runner/prompt-cache-observability.js";
import { guardSessionManager } from "../../src/agents/session-tool-result-guard-wrapper.js";
import { SessionManager } from "../../src/agents/sessions/session-manager.js";
import type { Message } from "../../src/llm/types.js";
import { isDeeplyFrozenPlainData } from "../../src/shared/immutable-data.js";

const { values } = parseArgs({
  options: {
    "append-owner": { type: "string" },
    rounds: { type: "string", default: "3000" },
    allocation: { type: "boolean", default: false },
  },
});
const rounds = Number(values.rounds);
assert.ok(Number.isSafeInteger(rounds) && rounds > 0);
assert.ok(global.gc, "Pass --expose-gc");
const {
  persistAgentSessionMessage,
}: typeof import("../../src/agents/sessions/agent-session-transcript.js") = await import(
  values["append-owner"]
    ? pathToFileURL(values["append-owner"]).href
    : "../../src/agents/sessions/agent-session-transcript.js"
);
const messages: Message[] = [];
const manager = guardSessionManager(SessionManager.inMemory(), { allowedToolNames: ["read"] });
for (let index = 0; index < 20; index++) {
  messages.push(
    {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "fixture-model",
      content: [
        {
          type: "thinking",
          thinking: "Synthetic reasoning ".repeat(100),
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: `rs_${index}`,
            summary: [],
            encrypted_content: "synthetic-ciphertext",
          }),
          openclawReasoningReplay: {
            v: 1,
            source: "openai-responses",
            provider: "openai",
            api: "openai-responses",
            model: "fixture-model",
            baseUrlHash: "abc123",
          },
        },
        {
          type: "toolCall",
          id: `call_${index}`,
          name: "read",
          arguments: { path: `fixture-${index}`, options: { lines: [1, 2, 3] } },
        },
      ],
      usage: {
        input: 10000,
        output: 100,
        cacheRead: 9000,
        cacheWrite: 0,
        totalTokens: 10100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: index * 2,
    },
    {
      role: "toolResult",
      toolCallId: `call_${index}`,
      toolName: "read",
      content: [{ type: "text", text: "Synthetic tool output ".repeat(200) }],
      details: { path: `fixture-${index}` },
      isError: false,
      timestamp: index * 2 + 1,
    },
  );
}
const originalBytes = JSON.stringify(messages);
const appendCpu = process.cpuUsage();
for (const message of messages) {
  await persistAgentSessionMessage(manager, message, { invalidateSerializedPrefixCache: false });
}
const appendUsed = process.cpuUsage(appendCpu);
assert.equal(JSON.stringify(messages), originalBytes);
const request = {
  sessionId: "synthetic-live-history",
  provider: "openai",
  modelId: "fixture-model",
  modelApi: "openai-responses",
  streamStrategy: "fixture",
  systemPrompt: "Stable synthetic prompt",
  tools: [],
  messages,
};
for (let round = 0; round < 100; round++) {
  beginPromptCacheObservation(request);
}
await setImmediate();
global.gc();
const inspector = values.allocation ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const gc: { kind: number; ms: number }[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.startTime >= started && entry.startTime < ended) {
      gc.push({
        kind: (entry as typeof entry & { detail: { kind: number } }).detail.kind,
        ms: entry.duration,
      });
    }
  }
});
observer.observe({ entryTypes: ["gc"] });
const hostLoad = loadavg();
const cpu = process.cpuUsage();
const started = performance.now();
for (let round = 0; round < rounds; round++) {
  assert.equal(beginPromptCacheObservation(request).prefixUnchanged, true);
}
const ended = performance.now();
const used = process.cpuUsage(cpu);
await setImmediate();
await setImmediate();
observer.disconnect();
let sampledBytes = 0;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const pending = [profile.head];
  while (pending.length) {
    const node = pending.pop()!;
    sampledBytes += node.selfSize;
    pending.push(...node.children);
  }
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    rounds,
    allocation: values.allocation,
    hostLoad,
    messages: messages.length,
    immutable: messages.filter(isDeeplyFrozenPlainData).length,
    payloadDigest: hash("sha256", originalBytes, "hex"),
    appendCpuMs: (appendUsed.user + appendUsed.system) / 1000,
    cpuMsPerRequest: (used.user + used.system) / 1000 / rounds,
    msPerRequest: (ended - started) / rounds,
    sampledBytesPerRequest: inspector ? sampledBytes / rounds : undefined,
    gc,
    memory: process.memoryUsage(),
  }),
);
manager.clearTranscriptRunCallbacks?.();
