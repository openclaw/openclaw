// Benchmark host only: node --import ./scripts/tsx.mjs scripts/perf/hook-isolation-measure.ts --expect-shared-history
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { canonicalizeSessionEntry } from "../../src/agents/sessions/session-manager-persistence-entry.js";
import { isOwnedTranscriptPayload } from "../../src/config/sessions/transcript-json.js";
import type { PluginHookBeforePromptBuildEvent } from "../../src/plugins/hook-before-agent-start.types.js";
import { createHookRunner } from "../../src/plugins/hooks.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";

const { values } = parseArgs({
  options: {
    calls: { type: "string", default: "40" },
    samples: { type: "string", default: "5" },
    "start-at": { type: "string", default: "0" },
    "expect-shared-history": { type: "boolean", default: false },
    "preflight-only": { type: "boolean", default: false },
  },
});
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

const cells = [200, 1_000].flatMap((size) => {
  const messages = fixture(size);
  for (const message of messages) {
    assert.ok(isOwnedTranscriptPayload(message));
    assert.ok(Object.isFrozen(message.content));
    assert.ok(!isOwnedTranscriptPayload(message.content));
  }
  return [1, 2].map((handlers) => {
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
              assert.equal(received.content === original.content, values["expect-shared-history"]);
              assert.equal(Object.isFrozen(received.content), values["expect-shared-history"]);
            }
          }
          return { prependContext: "synthetic context" };
        },
      });
    }
    const runner = createHookRunner(registry, { catchErrors: false });
    const event = { prompt: "synthetic prompt", messages };
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
  let clones = 0;
  let ownedPayloadClones = 0;
  let sourceEnumerations = 0;
  let cloneEnumerations = 0;
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
    });
  } finally {
    Reflect.ownKeys = ownKeys;
    globalThis.structuredClone = clone;
  }
  if (!values["preflight-only"]) {
    await cell.run(10);
  }
}
if (values["preflight-only"]) {
  console.log(
    JSON.stringify({
      node: process.version,
      expectedSharedHistory: values["expect-shared-history"],
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

function allocatedBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocatedBytes(child), 0);
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
      const sampledBytes = allocatedBytes(profile.head);
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
    samplingInterval: 8_192,
    includeCollectedObjects: true,
    expectedSharedHistory: values["expect-shared-history"],
    counts,
    fixtures: cells.map(({ messages, handlers, fixtureBytes }) => ({
      messages,
      handlers,
      fixtureBytes,
    })),
    rows,
  }),
);
