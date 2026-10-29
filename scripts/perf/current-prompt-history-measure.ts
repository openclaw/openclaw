/**
 * Current-prompt boundary: 600 immutable messages with user/assistant/tool turns.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/current-prompt-history-measure.ts \
 *   --mode timing --iterations 3000 --owner-file .local/base-attempt-llm-boundary.ts
 * Omit --owner-file for current source. Run five alternating base/candidate pairs
 * separately for timing, allocation and survivors. Survivors excludes objects
 * collected by minor GC, with one final scavenge; this is not exact promotion.
 * Retained mode holds 128 prepared histories across full GC to measure live heap.
 * Acceptance: identical output hashes, lower allocation, no material CPU increase.
 * A redundant temporary array deletion need not reduce long-lived message payloads.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { freezeJsonSnapshot } from "../../src/shared/immutable-data.js";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
    samples: { type: "string", default: "5" },
  },
});
const iterations = Number(values.iterations);
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["timing", "allocation", "survivors", "retained"].includes(values.mode));
const collectGarbage = global.gc;
assert(collectGarbage, "use --expose-gc");
const ownerUrl = new URL(
  "../../src/agents/embedded-agent-runner/run/attempt-llm-boundary.ts",
  import.meta.url,
).href;
let loaded = false;
const hooks = registerHooks({
  load(url, context, next) {
    if (url.split("?")[0] !== ownerUrl) {
      return next(url, context);
    }
    loaded = true;
    return {
      format: "module",
      source: stripTypeScriptTypes(
        readFileSync(url.endsWith("?base") ? values["owner-file"]! : new URL(ownerUrl), "utf8"),
      ),
      shortCircuit: true,
    };
  },
});
type BoundaryOwner =
  typeof import("../../src/agents/embedded-agent-runner/run/attempt-llm-boundary.js");
const candidate: BoundaryOwner = await import(`${ownerUrl}?candidate`);
const base: BoundaryOwner | undefined = values["owner-file"]
  ? await import(`${ownerUrl}?base`)
  : undefined;
hooks.deregister();
assert(loaded, "selected owner must load");
const messages: AgentMessage[] = [];
for (let index = 0; index < 200; index++) {
  messages.push(
    { role: "user", content: `Request ${index}`, timestamp: index * 3 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: `call_${index}`, name: "read", arguments: { index } }],
      api: "openai-completions",
      provider: "synthetic",
      model: "synthetic",
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: index * 3 + 1,
    },
    {
      role: "toolResult",
      toolCallId: `call_${index}`,
      toolName: "read",
      content: [{ type: "text", text: `Result ${index}: ${"synthetic data ".repeat(100)}` }],
      isError: false,
      timestamp: index * 3 + 2,
    },
  );
}
freezeJsonSnapshot(messages);
const params = {
  messages,
  prompt: "Current request",
  currentUserTimestamp: 1000,
  sessionVersion: 4,
  appendOnlyRuntimeContext: true,
  inHistorySystemUpdates: true,
  includeTimestamp: false,
};
async function measure(
  arm: string,
  prepare: typeof candidate.normalizeMessagesForCurrentPromptBoundary,
  sample: number,
  gc: NonNullable<typeof global.gc>,
) {
  let output = prepare(params);
  const expectedBytes = JSON.stringify(messages);
  assert.equal(JSON.stringify(output), expectedBytes);
  function run(count: number) {
    for (let index = 0; index < count; index++) {
      output = prepare(params);
    }
  }
  run(500);
  gc();
  const inspector = new Session();
  const sampled = values.mode === "allocation" || values.mode === "survivors";
  if (sampled) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: values.mode === "allocation",
    });
  }
  const retained: AgentMessage[][] = [];
  const heapBefore = process.memoryUsage().heapUsed;
  const hostLoad = loadavg();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  if (values.mode === "retained") {
    for (let index = 0; index < 128; index++) {
      retained.push(prepare(params));
    }
  } else {
    run(iterations);
  }
  const wallMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  let allocatedBytes: number | undefined;
  if (sampled) {
    if (values.mode === "survivors") {
      gc({ type: "minor", execution: "sync" });
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
    inspector.disconnect();
  }
  gc();
  const retainedBytes = process.memoryUsage().heapUsed - heapBefore;
  assert.equal(JSON.stringify(output), expectedBytes);
  assert.equal(JSON.stringify(messages), expectedBytes);
  assert.equal(retained.length, values.mode === "retained" ? 128 : 0);
  console.log(
    JSON.stringify({
      arm,
      sample,
      mode: values.mode,
      iterations: values.mode === "retained" ? 128 : iterations,
      historyMessages: messages.length,
      mainThreadCpuMs: (used.user + used.system) / 1000,
      wallMs,
      allocatedBytes,
      bytesPerOperation: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      retainedBytes: values.mode === "retained" ? retainedBytes : undefined,
      outputSha256: createHash("sha256").update(expectedBytes).digest("hex"),
      hostLoad,
      memory: process.memoryUsage(),
    }),
  );
}
for (let sample = 0; sample < samples; sample++) {
  const arms: Array<readonly [string, BoundaryOwner]> = [["candidate", candidate]];
  if (base) {
    arms.push(["base", base]);
  }
  for (const [arm, owner] of sample % 2 === 0 ? arms.toReversed() : arms) {
    await measure(arm, owner.normalizeMessagesForCurrentPromptBoundary, sample + 1, collectGarbage);
  }
}
