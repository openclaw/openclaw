/**
 * Native multi-block reasoning: two messages, each with 2,048 64-byte appends,
 * three completed summaries (4 KiB each), commentary, and a tool-call block.
 * Run five interleaved base/candidate processes per mode (timing / allocation):
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/assistant-thinking-measure.ts \
 *   --owner-dir .local/base --mode timing
 * owner-dir contains stream-rendering.ts and messages.update.ts under their full
 * embedded-agent-subscribe.* filenames, plus embedded-agent-utils.ts.
 * Omit it for the checkout's owners.
 * --single-block also checks the previously optimized one-block stream.
 * --serialize consumes every cumulative event as JSON, including rope flattening.
 * Imports and warmup are excluded; subscription/fixture setup is included.
 * A win reduces owner
 * allocation/CPU with identical emitted summaries/deltas and untouched content.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { parseArgs } from "node:util";
import type { SubscribeEmbeddedAgentSessionParams } from "../../src/agents/embedded-agent-subscribe.types.js";
import type { AgentSessionEvent } from "../../src/agents/sessions/index.js";

const { values } = parseArgs({
  options: {
    "owner-dir": { type: "string" },
    "single-block": { type: "boolean", default: false },
    serialize: { type: "boolean", default: false },
    ready: { type: "string" },
    start: { type: "string" },
    mode: { type: "string", default: "timing" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
const owners = ["stream-rendering", "handlers.messages.update", "utils"].map((name) => {
  const filename =
    name === "utils" ? "embedded-agent-utils.ts" : `embedded-agent-subscribe.${name}.ts`;
  const url = new URL(`../../src/agents/${filename}`, import.meta.url).href;
  const source = readFileSync(
    values["owner-dir"] ? path.join(values["owner-dir"], filename) : new URL(url),
    "utf8",
  );
  return { url, source, loaded: false };
});
const hooks = registerHooks({
  load(url, context, next) {
    const owner = owners.find((entry) => entry.url === url);
    if (!owner) {
      return next(url, context);
    }
    owner.loaded = true;
    return { format: "module", source: stripTypeScriptTypes(owner.source), shortCircuit: true };
  },
});
const { subscribeEmbeddedAgentSession } =
  await import("../../src/agents/embedded-agent-subscribe.js");
const { appendAssistantThinking } =
  await import("../../packages/llm-core/src/utils/event-stream.js");
const { onAgentEventForRun } = await import("../../src/infra/agent-events.js");
const { sessionManagerReadTranscriptStart } =
  await import("../../src/agents/sessions/session-manager-current-turn.js");
const { makeAgentAssistantMessage } =
  await import("../../src/agents/test-helpers/agent-message-fixtures.js");
hooks.deregister();
assert(owners.every((owner) => owner.loaded));
const chunks = 2048;
const delta = "x".repeat(64);
const summaries = values["single-block"]
  ? []
  : ["First", "Second", "Third"].map((text) => text.padEnd(4096, "."));
const prefix = summaries.length ? summaries.join("\n") + "\n" : "";
const expected = prefix + delta.repeat(chunks);
let observedEvents = 0;
let serializedBytes = 0;
async function round(count = chunks) {
  let emit: ((event: AgentSessionEvent) => void) | undefined;
  const session = {
    sessionManager: { [sessionManagerReadTranscriptStart]: () => null },
    subscribe(callback: typeof emit) {
      emit = callback;
      return () => {};
    },
  } as unknown as SubscribeEmbeddedAgentSessionParams["session"];
  const runId = "assistant-thinking-measure";
  const subscription = subscribeEmbeddedAgentSession({
    session,
    runId,
    sessionPersistence: "detached",
  });
  const block = { type: "thinking" as const, thinking: "" };
  const message = makeAgentAssistantMessage({
    content: values["single-block"]
      ? [block]
      : [
          ...summaries.map((thinking) => ({ type: "thinking" as const, thinking })),
          { type: "text", text: "Checking the result." },
          { type: "toolCall", id: "synthetic-tool", name: "read", arguments: {} },
          block,
        ],
  });
  let finalText: unknown;
  let events = 0;
  let deltaChars = 0;
  const off = onAgentEventForRun(runId, (event) => {
    if (event.stream !== "thinking") {
      return;
    }
    if (values.serialize) {
      serializedBytes += JSON.stringify(event.data).length;
    }
    finalText = event.data.text;
    const emittedDelta = event.data.delta;
    assert.equal(emittedDelta, events === 0 ? prefix + delta : delta);
    if (typeof emittedDelta === "string") {
      deltaChars += emittedDelta.length;
    }
    events++;
  });
  assert(emit);
  try {
    emit({ type: "message_start", message });
    for (let index = 0; index < count; index++) {
      appendAssistantThinking(block, delta);
      emit({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: message.content.length - 1,
          delta,
          partial: message,
        },
      });
      await subscription.waitForPendingEvents();
    }
    const wanted = count === chunks ? expected : prefix + delta.repeat(count);
    assert.equal(finalText, wanted);
    assert.equal(deltaChars, wanted.length);
    assert.equal(events, count);
    assert.equal(block.thinking, delta.repeat(count));
    observedEvents += events;
  } finally {
    off();
    subscription.unsubscribe();
  }
}
await round(64);
serializedBytes = 0;
globalThis.gc?.();
if (values.ready && values.start) {
  writeFileSync(values.ready, "ready");
  while (!existsSync(values.start)) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}
let gcMs = 0;
let gcCount = 0;
let gcMaxMs = 0;
let measuredStart = Infinity;
let measuredEnd = Infinity;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.startTime < measuredStart || entry.startTime > measuredEnd) {
      continue;
    }
    gcMs += entry.duration;
    gcCount++;
    gcMaxMs = Math.max(gcMaxMs, entry.duration);
  }
});
observer.observe({ entryTypes: ["gc"] });
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const cpuStart = process.threadCpuUsage();
measuredStart = performance.now();
for (let index = 0; index < 2; index++) {
  await round();
}
measuredEnd = performance.now();
const wallMs = measuredEnd - measuredStart;
const cpu = process.threadCpuUsage(cpuStart);
let sampledProfile: HeapProfiler.SamplingHeapProfile | undefined;
if (values.mode === "allocation") {
  sampledProfile = (await inspector.post("HeapProfiler.stopSampling")).profile;
  inspector.disconnect();
}

await new Promise<void>((resolve) => {
  // GC entries arrive asynchronously; drain after stopping the measured window.
  setTimeout(resolve, 50);
});
observer.disconnect();
let sampledBytes = 0;
let extractionBytes = 0;
if (sampledProfile) {
  const sum = (node: HeapProfiler.SamplingHeapProfileNode, extraction = false) => {
    sampledBytes += node.selfSize;
    const inExtraction = extraction || node.callFrame.functionName === "extractAssistantThinking";
    if (inExtraction) {
      extractionBytes += node.selfSize;
    }
    for (const child of node.children) {
      sum(child, inExtraction);
    }
  };
  sum(sampledProfile.head);
}
console.log(
  JSON.stringify({
    mode: values.mode,
    singleBlock: values["single-block"],
    serializedBytes,
    sourceHash: createHash("sha256")
      .update(owners.map((owner) => owner.source).join("\n"))
      .digest("hex"),
    events: observedEvents - 64,
    cpuMs: (cpu.user + cpu.system) / 1000,
    wallMs,
    sampledBytes,
    extractionBytes,
    gcMs,
    gcCount,
    gcMaxMs,
    memory: process.memoryUsage(),
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  }),
);
