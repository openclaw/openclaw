// Benchmark host only: node --import ./scripts/tsx.mjs scripts/perf/hook-isolation-measure.ts
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { normalizeTranscriptJsonValue } from "../../src/config/sessions/transcript-json.js";
import { createHookRunner } from "../../src/plugins/hooks.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";

const { values } = parseArgs({
  options: {
    calls: { type: "string", default: "40" },
    samples: { type: "string", default: "5" },
    "start-at": { type: "string", default: "0" },
  },
});
const calls = Number(values.calls);
const samples = Number(values.samples);
assert.ok(Number.isSafeInteger(calls) && calls > 0, "calls must be a positive integer");
assert.ok(Number.isSafeInteger(samples) && samples >= 5, "samples must be at least five");

function fixture(size: number) {
  return Array.from({ length: size }, (_, index) =>
    normalizeTranscriptJsonValue(
      index % 2 === 0
        ? {
            role: "assistant",
            content: [
              {
                type: "toolCall",
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
            timestamp: index,
          }
        : {
            role: "toolResult",
            toolCallId: `call-${index - 1}`,
            toolName: "exec",
            content: [
              { type: "text", text: `Synthetic result ${index}: ${"output ".repeat(600)}` },
            ],
            details: { storageOnly: "private fixture detail" },
            __openclaw: { upstreamUserText: "storage-only fixture prompt", retained: "visible" },
            timestamp: index,
          },
      "",
    ),
  );
}

const cells = [200, 1_000].flatMap((size) => {
  const messages = fixture(size);
  return [1, 2].map((handlers) => {
    const registry = createEmptyPluginRegistry();
    let handlerCalls = 0;
    for (let index = 0; index < handlers; index++) {
      registry.typedHooks.push({
        pluginId: `synthetic-${index}`,
        hookName: "before_prompt_build",
        source: "synthetic",
        handler: () => {
          handlerCalls++;
          return { prependContext: "synthetic context" };
        },
      });
    }
    const runner = createHookRunner(registry);
    const event = { prompt: "synthetic prompt", messages };
    return {
      messages: size,
      handlers,
      fixtureBytes: Buffer.byteLength(JSON.stringify(event)),
      async run(count: number) {
        const before = handlerCalls;
        for (let call = 0; call < count; call++) {
          await runner.runBeforePromptBuild(event, {});
        }
        assert.equal(handlerCalls - before, count * handlers);
      },
    };
  });
});

// Count native clones and JS graph enumerations separately from either measured pass.
const counts = [];
for (const cell of cells) {
  const ownKeys = Reflect.ownKeys;
  const clone = globalThis.structuredClone;
  let clones = 0;
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
      return Reflect.apply(target, receiver, args);
    },
  });
  try {
    await cell.run(1);
    counts.push({
      messages: cell.messages,
      handlers: cell.handlers,
      dispatches: 1,
      clones,
      sourceEnumerations,
      cloneEnumerations,
    });
  } finally {
    Reflect.ownKeys = ownKeys;
    globalThis.structuredClone = clone;
  }
  await cell.run(10);
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
    counts,
    fixtures: cells.map(({ messages, handlers, fixtureBytes }) => ({
      messages,
      handlers,
      fixtureBytes,
    })),
    rows,
  }),
);
