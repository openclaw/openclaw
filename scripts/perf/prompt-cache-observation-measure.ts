// Run on a benchmark host with:
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/prompt-cache-observation-measure.ts
// Alternate base/head processes (five each). --envelopes projected uses the real
// tool-result details projection around shared frozen content; append leaves the
// normalized envelope mutable; sealed preserves the publication-only control.
// --reuse-view measures repeated observations of a retained model context.
// Retained/CPU runs are untraced; --measure allocation --output FILE samples
// allocations separately, including collected objects. --measure promotion with
// --trace-gc-nvp brackets the warm workload for a separate promotion pass.
// All fixtures are synthetic.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import { convertToLlm } from "../../packages/agent-core/src/harness/messages.js";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { fingerprintMessage } from "../../src/agents/embedded-agent-runner/prompt-cache-history.js";
import { clearPromptCacheObservations } from "../../src/agents/embedded-agent-runner/prompt-cache-observability.js";
import { createPromptCacheRequestObserver } from "../../src/agents/embedded-agent-runner/prompt-cache-request-observer.js";
import {
  isOwnedTranscriptPayload,
  normalizeTranscriptJsonValue,
} from "../../src/config/sessions/transcript-json.js";
import { cloneTranscriptView } from "../../src/config/sessions/transcript-snapshot.js";
import type { Message } from "../../src/llm/types.js";
import { isDeeplyFrozenPlainData } from "../../src/shared/immutable-data.js";
import { stripToolResultDetails } from "../../src/shared/model-context-message.js";

const { values } = parseArgs({
  options: {
    envelopes: { type: "string", default: "sealed" },
    "reuse-view": { type: "boolean", default: false },
    hydration: { type: "string", default: "shared" },
    sessions: { type: "string", default: "16" },
    messages: { type: "string", default: "128" },
    rounds: { type: "string", default: "20" },
    measure: { type: "string", default: "retained" },
    output: { type: "string" },
  },
});
assert.ok(global.gc, "Pass --expose-gc");
assert.ok(["sealed", "append", "projected"].includes(values.envelopes));
assert.ok(["shared", "clone"].includes(values.hydration));
assert.ok(["retained", "allocation", "snapshot", "promotion"].includes(values.measure));
const sessionCount = Number(values.sessions);
const messageCount = Number(values.messages);
const rounds = Number(values.rounds);
for (const count of [sessionCount, messageCount, rounds]) {
  assert.ok(Number.isSafeInteger(count) && count > 0);
}

function fixture(index: number): AgentMessage {
  const text = `Synthetic transcript ${index}: ${"sample text ".repeat(100)}`;
  let message: AgentMessage;
  switch (index % 4) {
    case 0:
      message = { role: "user", content: text, timestamp: index };
      break;
    case 1:
      message = {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "fixture-model",
        content: [
          { type: "thinking", thinking: text },
          {
            type: "toolCall",
            id: `call-${index}`,
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
        timestamp: index,
      };
      break;
    case 2:
      message = {
        role: "toolResult",
        toolCallId: `call-${index - 1}`,
        toolName: "read",
        content: [{ type: "text", text }],
        details: { path: `fixture-${index}`, lines: 10 },
        isError: false,
        timestamp: index,
      };
      break;
    default:
      message = {
        role: "custom",
        customType: "fixture-context",
        content: [{ type: "text", text }],
        display: false,
        timestamp: index,
      };
      break;
  }
  // Session append normalizes the message's children, then seals its envelope.
  // The envelope is deeply frozen but is not an ownedTranscriptPayload root.
  normalizeTranscriptJsonValue(message, "");
  return values.envelopes === "append" ? message : Object.freeze(message);
}
async function collect() {
  await setImmediate();
  global.gc!();
  await setImmediate();
  global.gc!();
}
const model = { provider: "openai", id: "fixture-model", api: "openai-responses" as const };
function createSession(index: number, count: number) {
  return {
    entries: Array.from({ length: count }, (_, offset) => ({
      type: "message",
      message: fixture(index * messageCount + offset),
    })),
    messages: [] as Message[],
    observer: createPromptCacheRequestObserver(
      { sessionId: `retention-${index}`, streamStrategy: "fixture" },
      () => {},
    ),
  };
}
let cpuMicros = 0;
let observationMs = 0;
let calls = 0;
let stablePrefixes = 0;
function hydrate(session: ReturnType<typeof createSession>) {
  const view =
    values.hydration === "clone"
      ? structuredClone(session.entries)
      : cloneTranscriptView(session.entries);
  const messages = view.map((entry) => entry.message);
  session.messages = convertToLlm(
    values.envelopes === "projected" ? stripToolResultDetails(messages) : messages,
  );
}
async function observe(session: ReturnType<typeof createSession>, refresh = true) {
  if (refresh || !session.messages.length) {
    hydrate(session);
  }
  const messages = session.messages;
  const cpu = process.cpuUsage();
  const started = performance.now();
  const result = await session.observer.onModelRequest(model, {
    messages,
    systemPrompt: "Synthetic stable prompt",
    tools: [],
  });
  observationMs += performance.now() - started;
  const used = process.cpuUsage(cpu);
  cpuMicros += used.user + used.system;
  calls++;
  if (result.prefixUnchanged) {
    stablePrefixes++;
  }
  assert.equal(result.changes, null);
  session.observer.onModelUsage({ input: 1000, cacheRead: 9000 });
}
async function warm() {
  // Use the measured history size and all roles before collecting the heap baseline.
  const session = createSession(sessionCount, messageCount);
  for (let round = 0; round < 100; round++) {
    await observe(session);
  }
}
await warm();
clearPromptCacheObservations();
await collect();
const sessions = Array.from({ length: sessionCount }, (_, index) =>
  createSession(index, messageCount),
);
// Include the hydration owner's existing frozen-data proof before measuring observation state.
for (const session of sessions) {
  hydrate(session);
}
const firstViews = sessions.flatMap(({ messages }) =>
  messages.map((message) => new WeakRef(message)),
);
const shapes: Record<string, number> = {};
for (const message of sessions[0]!.messages) {
  const shape = isOwnedTranscriptPayload(message)
    ? "owned"
    : isDeeplyFrozenPlainData(message)
      ? "deeplyFrozen"
      : isDeeplyFrozenPlainData(message.content)
        ? "mutableEnvelopeFrozenContent"
        : "fullyMutable";
  shapes[shape] = (shapes[shape] ?? 0) + 1;
}
await collect();
const inspector = values.measure === "allocation" ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
if (values.measure === "snapshot") {
  assert.ok(values.output);
  writeHeapSnapshot(`${values.output}.before.heapsnapshot`);
}
const before = process.memoryUsage().heapUsed;
cpuMicros = 0;
observationMs = 0;
calls = 0;
stablePrefixes = 0;
for (const session of sessions) {
  await observe(session, false);
}
await collect();
const first = process.memoryUsage().heapUsed;
const coldCpuMsPerCall = cpuMicros / 1000 / calls;
if (values.measure === "snapshot") {
  writeHeapSnapshot(`${values.output}.first.heapsnapshot`);
}
cpuMicros = 0;
observationMs = 0;
calls = 0;
stablePrefixes = 0;
const gc: Array<{ kind: number; ms: number }> = [];
if (values.measure === "promotion") {
  console.log("PROMOTION_START");
}
const started = performance.now();
let ended = Infinity;
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
for (let round = 0; round < rounds; round++) {
  for (const session of sessions) {
    await observe(session, !values["reuse-view"]);
  }
}
ended = performance.now();
if (values.measure === "promotion") {
  console.log("PROMOTION_END");
}
await setImmediate();
await setImmediate();
observer.disconnect();
await collect();
const final = process.memoryUsage().heapUsed;
if (values.measure === "snapshot") {
  writeHeapSnapshot(`${values.output}.final.heapsnapshot`);
}
if (inspector) {
  assert.ok(values.output);
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  await writeFile(values.output, JSON.stringify(profile));
  inspector.disconnect();
}
assert.equal(stablePrefixes, calls);
const firstViewsAliveAfterReplacement = firstViews.filter((ref) => ref.deref()).length;
const currentViews = sessions.flatMap(({ messages }) =>
  messages.map((message) => new WeakRef(message)),
);
const fingerprintDigest = hash(
  "sha256",
  JSON.stringify(
    sessions.map(({ messages }) =>
      messages.map((message) => {
        const { stringBlock: _stringBlock, ...fingerprint } = fingerprintMessage(message);
        return fingerprint;
      }),
    ),
  ),
  "hex",
);
for (const session of sessions) {
  session.messages = [];
}
await collect();
const released = process.memoryUsage().heapUsed;
const currentViewsAliveAfterRelease = currentViews.filter((ref) => ref.deref()).length;
const residentMessages = sessionCount * messageCount;
console.log(
  JSON.stringify({
    node: process.version,
    hydration: values.hydration,
    envelopes: values.envelopes,
    reuseView: values["reuse-view"],
    shapesPerRequest: shapes,
    firstViewsAliveAfterReplacement,
    currentViewsAliveAfterRelease,
    retainedAfterViewRelease: released - before,
    fingerprintDigest,
    measure: values.measure,
    sessionCount,
    messageCount,
    rounds,
    modelCalls: calls + sessionCount,
    residentMessages,
    retainedFirst: first - before,
    retainedFinal: final - before,
    retainedBytesPerSession: (final - before) / sessionCount,
    retainedBytesPerMessage: (final - before) / residentMessages,
    retainedBytesPerCall: (final - before) / (calls + sessionCount),
    coldCpuMsPerCall,
    warmCpuMsPerCall: cpuMicros / 1000 / calls,
    warmMsPerCall: observationMs / calls,
    warmCalls: calls,
    gc,
    fixtureDigest: hash("sha256", JSON.stringify(sessions.map(({ entries }) => entries)), "hex"),
  }),
);
clearPromptCacheObservations();
