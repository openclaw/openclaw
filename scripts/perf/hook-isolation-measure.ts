// node --import ./scripts/tsx.mjs scripts/perf/hook-isolation-measure.ts --expect-shared-history
// Compare the same --calls/--samples with --prompt-chars 16 and 262144 on both revisions.
// Add --unowned-history to cover callers without transcript-owner sealing.
// Combine --unowned-history --projected-history for already-sanitized mutable worker model context.
// Add --no-result to measure hooks that observe inputs without returning modifications.
// Use --messages 200 --calls 1000 for the 0/1/3-hook prompt-envelope workload.
// Counts, unprofiled CPU, and sampled allocations are separate passes; use built Gateway stress too.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { canonicalizeSessionEntry } from "../../src/agents/sessions/session-manager-persistence-entry.js";
import { isOwnedTranscriptPayload } from "../../src/config/sessions/transcript-json.js";
import type { PluginHookBeforePromptBuildEvent } from "../../src/plugins/hook-before-agent-start.types.js";
import { createHookRunner } from "../../src/plugins/hooks.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { projectModelContextMessages } from "../../src/shared/model-context-message.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    calls: { type: "string", default: "40" },
    messages: { type: "string" },
    "prompt-chars": { type: "string", default: "16" },
    "unowned-history": { type: "boolean", default: false },
    "projected-history": { type: "boolean", default: false },
    "no-result": { type: "boolean", default: false },
    samples: { type: "string", default: "5" },
    "start-at": { type: "string", default: "0" },
    "expect-shared-history": { type: "boolean", default: false },
    "preflight-only": { type: "boolean", default: false },
  },
});
const promptChars = Number(values["prompt-chars"]);
assert.ok(Number.isSafeInteger(promptChars) && promptChars >= 0);
const expectSharedHistory = values["expect-shared-history"] && !values["unowned-history"];
assert.ok(!values["projected-history"] || values["unowned-history"]);
const calls = Number(values.calls);
const samples = Number(values.samples);
assert.ok(Number.isSafeInteger(calls) && calls > 0, "calls must be a positive integer");
assert.ok(Number.isSafeInteger(samples) && samples >= 5, "samples must be at least five");

function fixture(size: number) {
  return Array.from(
    { length: size },
    (_, index) =>
      canonicalizeSessionEntry({
        type: "message",
        id: `message-${index}`,
        parentId: index === 0 ? null : `message-${index - 1}`,
        timestamp: "2026-10-24T00:00:00.000Z",
        message:
          index % 2 === 0
            ? {
                role: "assistant" as const,
                content: [
                  {
                    type: "toolCall" as const,
                    id: `call-${index}`,
                    name: "exec",
                    arguments: {
                      command: "synthetic-workload",
                      items: Array.from({ length: 16 }, (_entry, item) => ({
                        item,
                        text: "x".repeat(256),
                      })),
                    },
                  },
                ],
                api: "synthetic",
                provider: "synthetic",
                model: "synthetic",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "toolUse" as const,
                timestamp: index,
              }
            : {
                role: "toolResult" as const,
                toolCallId: `call-${index - 1}`,
                toolName: "exec",
                content: [
                  {
                    type: "text" as const,
                    text: `Synthetic result ${index}: ${"output ".repeat(600)}`,
                  },
                ],
                details: { storageOnly: "private fixture detail" },
                __openclaw: {
                  upstreamUserText: "storage-only fixture prompt",
                  retained: "visible",
                },
                isError: false,
                timestamp: index,
              },
      }).message,
  );
}

const sizes = values.messages ? [Number(values.messages)] : [64, 200, 1_000];
assert.ok(sizes.every((size) => Number.isSafeInteger(size) && size > 0));
const cells = sizes.flatMap((size) => {
  const fixtureMessages = fixture(size);
  const source = values["projected-history"]
    ? projectModelContextMessages(fixtureMessages)
    : fixtureMessages;
  const isFixtureMessage = (message: unknown): message is { content: unknown[] } =>
    Boolean(
      message &&
      typeof message === "object" &&
      "content" in message &&
      Array.isArray(message.content),
    );
  const messages = (values["unowned-history"] ? structuredClone(source) : source).map((message) => {
    assert.ok(isFixtureMessage(message));
    return message;
  });
  for (const message of messages) {
    if (!values["projected-history"]) {
      assert.equal(isOwnedTranscriptPayload(message), !values["unowned-history"]);
    }
    assert.equal(Object.isFrozen(message.content), !values["unowned-history"]);
    assert.ok(!isOwnedTranscriptPayload(message.content));
  }
  return [0, 1, 3].map((handlers) => {
    const registry = createEmptyPluginRegistry();
    let handlerCalls = 0;
    let verifyHistory = false;
    for (let handlerIndex = 0; handlerIndex < handlers; handlerIndex++) {
      registry.typedHooks.push({
        pluginId: `synthetic-${handlerIndex}`,
        hookName: "before_prompt_build",
        source: "synthetic",
        handler: (event: PluginHookBeforePromptBuildEvent) => {
          handlerCalls++;
          if (verifyHistory) {
            assert.notEqual(event.messages, messages);
            for (let index = 0; index < messages.length; index++) {
              const received = event.messages[index];
              const original = messages[index]!;
              assert.ok(received && typeof received === "object" && "content" in received);
              assert.notEqual(received, original);
              assert.equal(received.content === original.content, expectSharedHistory);
              assert.equal(Object.isFrozen(received.content), expectSharedHistory);
            }
          }
          return values["no-result"] ? undefined : { prependContext: "synthetic context" };
        },
      });
    }
    const runner = createHookRunner(registry, { catchErrors: false });
    const event = { prompt: "p".repeat(promptChars), messages };
    return {
      messages: size,
      handlers,
      contentRoots: new Set<object>(messages.map((message) => message.content)),
      fixtureBytes: Buffer.byteLength(JSON.stringify(event)),
      async run(count: number, verifyInputs = false) {
        verifyHistory = verifyInputs;
        const before = handlerCalls;
        try {
          for (let call = 0; call < count; call++) {
            await runner.runBeforePromptBuild(event, {});
          }
          assert.equal(handlerCalls - before, count * handlers);
        } finally {
          verifyHistory = false;
        }
      },
    };
  });
});

// Count native clones and JS graph enumerations separately from either measured pass.
function countContentRoots(value: unknown, roots: Set<object>, seen = new Set<object>()): number {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return 0;
  }
  seen.add(value);
  if (roots.has(value)) {
    return 1;
  }
  // The synthetic fixture contains only ordinary JSON envelopes and payloads.
  return Object.values(value).reduce<number>(
    (count, entry: unknown) => count + countContentRoots(entry, roots, seen),
    0,
  );
}

const counts = [];
for (const cell of cells) {
  const ownKeys = Reflect.ownKeys;
  const clone = globalThis.structuredClone;
  const getDescriptor = Object.getOwnPropertyDescriptor;
  let clones = 0;
  let ownedPayloadClones = 0;
  let sourceEnumerations = 0;
  let cloneEnumerations = 0;
  let snapshotDescriptorReads = 0;
  Object.getOwnPropertyDescriptor = new Proxy(getDescriptor, {
    apply(target, receiver, args: Parameters<typeof getDescriptor>) {
      if (clones > 0) {
        snapshotDescriptorReads++;
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  Reflect.ownKeys = new Proxy(ownKeys, {
    apply(target, receiver, args: Parameters<typeof ownKeys>) {
      if (clones === 0) {
        sourceEnumerations++;
      } else {
        cloneEnumerations++;
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  globalThis.structuredClone = new Proxy(clone, {
    apply(target, receiver, args: Parameters<typeof clone>) {
      clones++;
      ownedPayloadClones += countContentRoots(args[0], cell.contentRoots);
      return Reflect.apply(target, receiver, args);
    },
  });
  try {
    await cell.run(1, true);
    counts.push({
      messages: cell.messages,
      handlers: cell.handlers,
      dispatches: 1,
      clones,
      ownedPayloadClones,
      sourceEnumerations,
      cloneEnumerations,
      snapshotDescriptorReads,
    });
  } finally {
    Reflect.ownKeys = ownKeys;
    globalThis.structuredClone = clone;
    Object.getOwnPropertyDescriptor = getDescriptor;
  }
  if (!values["preflight-only"]) {
    await cell.run(10);
  }
}
if (values["preflight-only"]) {
  console.log(
    JSON.stringify({
      node: process.version,
      expectedSharedHistory: expectSharedHistory,
      unownedHistory: values["unowned-history"],
      projectedHistory: values["projected-history"],
      counts,
    }),
  );
  process.exit(0);
}
const startAt = Number(values["start-at"]);
assert.ok(Number.isFinite(startAt) && startAt >= 0, "start-at must be a Unix timestamp in ms");
if (startAt) {
  assert.ok(startAt > Date.now(), "missed synchronized start after warmup");
  await new Promise((resolve) => {
    setTimeout(resolve, startAt - Date.now());
  });
}

const rows = [];
for (let sample = 0; sample < samples; sample++) {
  for (const cell of cells) {
    const before = process.cpuUsage();
    const started = performance.now();
    await cell.run(calls);
    const wallMs = performance.now() - started;
    const cpu = process.cpuUsage(before);
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    rows.push({
      mode: "unprofiled",
      sample,
      messages: cell.messages,
      handlers: cell.handlers,
      calls,
      wallMs,
      cpuMs,
      wallMsPerDispatch: wallMs / calls,
      cpuMsPerDispatch: cpuMs / calls,
    });
  }
}

const inspector = new Session();
inspector.connect();
try {
  for (let sample = 0; sample < samples; sample++) {
    for (const cell of cells) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 8_192,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      await cell.run(calls);
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const sampledBytes = sumSampledHeapBytes(profile.head);
      rows.push({
        mode: "allocation",
        sample,
        messages: cell.messages,
        handlers: cell.handlers,
        calls,
        sampledBytes,
        sampledBytesPerDispatch: sampledBytes / calls,
        heapSamples: profile.samples.length,
      });
    }
  }
} finally {
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    node: process.version,
    calls,
    samples,
    promptChars,
    samplingInterval: 8_192,
    includeCollectedObjects: true,
    expectedSharedHistory: expectSharedHistory,
    unownedHistory: values["unowned-history"],
    projectedHistory: values["projected-history"],
    counts,
    fixtures: cells.map(({ messages, handlers, fixtureBytes }) => ({
      messages,
      handlers,
      fixtureBytes,
    })),
    rows,
  }),
);
