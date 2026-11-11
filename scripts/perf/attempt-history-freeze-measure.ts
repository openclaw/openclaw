/**
 * Attempt preparation with synthetic admitted transcript histories, plus a new
 * shallow-frozen assistant tail. No database, provider, or live Gateway access.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/attempt-history-freeze-measure.ts \
 *   --histories 128 --messages 600 --iterations 1024
 * Use --allocation in separate processes. --owner selects an adjacent baseline
 * attempt-history-prepare module with unchanged dependencies. Run two A/A pairs
 * then five alternating A/B pairs. Accept identical bytes and immutability, zero
 * admitted-prefix walks, lower CPU/allocation beyond controls, and no material
 * p95 or GC regression. --restored --iterations 128 measures each private writable
 * initial-context clone once; cloning stays outside measurement. Ordinary persistent
 * startup uses these private views; admitted identities model detached retries and
 * live replies retained for finalization. The entry-point regression exercises real
 * in-memory append/read admission. This is owner cost, not Gateway latency or DB scale.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createToolResultPromptProjectionState } from "../../src/agents/embedded-agent-runner/session-prompt-state.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { cloneSessionModelContextEntries } from "../../src/agents/sessions/session-manager-codec.js";
import { SessionManager } from "../../src/agents/sessions/session-manager.js";
import { SettingsManager } from "../../src/agents/sessions/settings-manager.js";
import { normalizeTranscriptJsonValue } from "../../src/config/sessions/transcript-json-normalize.js";
import { isOwnedTranscriptPayload } from "../../src/config/sessions/transcript-json.js";
import { createStageTimingTracker } from "../../src/shared/stage-timing.js";
import { recordGcCollections } from "../lib/perf-gc-collections.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    histories: { type: "string", default: "128" },
    messages: { type: "string", default: "600" },
    iterations: { type: "string", default: "1024" },
    allocation: { type: "boolean", default: false },
    restored: { type: "boolean", default: false },
  },
});
const histories = Number(values.histories);
const messages = Number(values.messages);
const iterations = Number(values.iterations);
assert([histories, messages, iterations].every((n) => Number.isSafeInteger(n) && n > 0));
assert.equal(messages % 3, 0);
assert(global.gc, "Pass --expose-gc");
const {
  prepareEmbeddedAttemptHistory: prepare,
}: typeof import("../../src/agents/embedded-agent-runner/run/attempt-history-prepare.js") =
  await import(
    values.owner
      ? pathToFileURL(values.owner).href
      : "../../src/agents/embedded-agent-runner/run/attempt-history-prepare.js"
  );
const text = "Synthetic tool payload. ".repeat(400).slice(0, 8192);
const assistant = (id: number): AgentMessage => ({
  role: "assistant",
  api: "openai-responses",
  provider: "openai",
  model: "fixture-model",
  content: [
    {
      type: "toolCall",
      id: `call_${id}`,
      name: "read",
      arguments: {
        path: `file-${id}`,
        text,
        options: { sections: Array.from({ length: 8 }, (_, line) => ({ line })) },
      },
    },
  ],
  timestamp: id,
  usage: {
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 110,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
});
const fixtures = Array.from({ length: histories }, (_history, history) => {
  const retained: AgentMessage[] = Array.from({ length: messages / 3 }, (_, index) => [
    { role: "user" as const, content: `Read ${history}/${index}`, timestamp: index },
    assistant(index),
    {
      role: "toolResult" as const,
      toolCallId: `call_${index}`,
      toolName: "read",
      content: [{ type: "text" as const, text }],
      timestamp: index,
      isError: false,
    },
  ]).flat();
  for (const message of retained) {
    normalizeTranscriptJsonValue({ message }, "");
  }
  assert(retained.every(isOwnedTranscriptPayload));
  const agent = { state: { messages: retained } };
  const input = {
    attempt: {
      model: { api: "fixture", id: "fixture-model" },
      modelId: "fixture-model",
      provider: "",
      sessionId: `fixture-${history}`,
    },
    prepared: {
      sessionRuntime: {
        agentSession: {
          activeSession: {
            agent,
            get messages() {
              return agent.state.messages;
            },
          },
          settingsManager: SettingsManager.inMemory(),
        },
        boundary: {},
        sessionManager: SessionManager.inMemory(),
        toolResultPromptProjectionState: createToolResultPromptProjectionState(),
        transcriptPolicy: { sanitizeMode: "images-only" },
        transport: {},
        state: { systemPromptText: "Synthetic prompt" },
      },
      toolCatalog: { toolSearchRunPlan: {} },
    },
    setup: {
      sessionAgentId: "main",
      effectiveWorkspace: "/synthetic",
      prepStages: createStageTimingTracker(() => 0),
    },
  } as Parameters<typeof prepare>[0];
  return { retained, agent, input };
});
const run = async (index: number) => {
  const fixture = fixtures[index % histories]!;
  const tail = Object.freeze({
    ...assistant(messages),
    content: [{ type: "text" as const, text: "New reply" }],
    stopReason: "stop" as const,
  });
  fixture.agent.state.messages = [...fixture.retained, tail];
  await prepare(fixture.input, () => {});
  return fixture.agent.state.messages;
};
function restorePrivateViews() {
  if (!values.restored) {
    return;
  }
  assert(iterations <= histories, "Restored measurement visits each private view once");
  for (const fixture of fixtures) {
    const entries = cloneSessionModelContextEntries(
      fixture.retained.map((message, index) => ({
        type: "message",
        id: String(index),
        parentId: index ? String(index - 1) : null,
        timestamp: new Date(0).toISOString(),
        message,
      })),
    );
    fixture.retained = entries.flatMap((entry) =>
      entry.type === "message" ? [entry.message] : [],
    );
    assert(
      fixture.retained.every(
        (message) => !Object.isFrozen(message) && !isOwnedTranscriptPayload(message),
      ),
    );
  }
}
restorePrivateViews();
const proof = await run(0);
assert.equal(proof.length, messages + 1);
assert.equal(proof[1], fixtures[0]!.retained[1]);
const publishedTail = proof.at(-1);
assert(publishedTail?.role === "assistant");
assert(Object.isFrozen(publishedTail.content));
assert.equal(Reflect.set(publishedTail.content[0]!, "text", "changed"), false);
const digest = hash("sha256", JSON.stringify(proof));
for (let i = 0; i < Math.max(128, histories); i++) {
  await run(i);
}
restorePrivateViews();
await setImmediate();
global.gc();
const profiler = values.allocation ? new Session() : undefined;
if (profiler) {
  profiler.connect();
  await profiler.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const gc: { kind: number; ms: number }[] = [];
const observer = new PerformanceObserver((list) =>
  recordGcCollections(list.getEntries(), gc, started, ended),
);
observer.observe({ entryTypes: ["gc"] });
const hostLoad = loadavg();
const times: number[] = [];
const cpu = process.threadCpuUsage();
const started = performance.now();
for (let i = 0; i < iterations; i++) {
  const begin = performance.now();
  await run(i);
  times.push(performance.now() - begin);
}
const ended = performance.now();
const used = process.threadCpuUsage(cpu);
await setImmediate();
await setImmediate();
observer.disconnect();
let sampledBytes: number | undefined;
if (profiler) {
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  profiler.disconnect();
}
times.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    restored: values.restored,
    histories,
    messages,
    iterations,
    allocation: values.allocation,
    owner: values.owner ?? "candidate",
    digest,
    hostLoad,
    cpuUs: profiler ? undefined : (used.user + used.system) / iterations,
    wallMs: profiler ? undefined : (ended - started) / iterations,
    p95Ms: profiler ? undefined : times[Math.floor(times.length * 0.95)],
    sampledBytesPerAttempt: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    gc,
    memory: process.memoryUsage(),
  }),
);
