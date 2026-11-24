/**
 * Context-usage owner proof with frozen tool-heavy histories and 4 KiB reasoning.
 * Run timing/allocation separately, alternating base/candidate five times:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/responses-context-usage.ts \
 *   --items 2000 --iterations 1000 [--allocation] [--module <owner.ts>] [--retention]
 * A baseline module can be materialized beside the owner with git show; its
 * dependencies must match the candidate. Remove that temporary module afterward.
 * This invokes recordResponsesContextUsage, including its real replay conversion.
 * Fresh request arrays share frozen items; fixture preparation is outside timing.
 * Test 200/1000/2000 items. Accept identical hashes, lower allocation/main-thread
 * CPU across five arms, and weak-key release. Retention runs separately, including
 * preparation, warm-cache growth and release; GC timings are not Gateway tails.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { configureAiTransportHost } from "../../packages/ai/src/host.js";
import type { ResponsesContinuationRequest } from "../../packages/ai/src/transports/openai-responses-continuation.js";
import { readResponsesInputReplayState } from "../../packages/ai/src/transports/openai-responses-input-replay.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../src/shared/immutable-data.js";
import { summarizeGcByKind } from "../lib/gc-profile-summary.ts";

const { values } = parseArgs({
  options: {
    items: { type: "string", default: "2000" },
    iterations: { type: "string", default: "1000" },
    allocation: { type: "boolean", default: false },
    retention: { type: "boolean", default: false },
    module: { type: "string" },
  },
});
const items = Number(values.items);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(items) && items >= 5 && items % 5 === 0);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(globalThis.gc, "Use --expose-gc");
const modulePath = values.module
  ? resolve(values.module)
  : fileURLToPath(
      new URL(
        "../../packages/ai/src/transports/openai-responses-context-usage.ts",
        import.meta.url,
      ),
    );
const owner: typeof import("../../packages/ai/src/transports/openai-responses-context-usage.js") =
  await import(pathToFileURL(modulePath).href);
configureAiTransportHost({ immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData } });
const model: Model = {
  api: "openai-responses",
  provider: "openai",
  id: "fixture-model",
  name: "fixture-model",
  baseUrl: "https://provider.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
};
const message: AssistantMessage = {
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  stopReason: "stop",
  timestamp: 0,
  usage: {
    input: 500,
    output: 25,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 525,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    contextUsage: { state: "available", promptTokens: 500, totalTokens: 525 },
  },
};
const input: NonNullable<ResponsesContinuationRequest["input"]> = [];
for (let turn = 0; turn < items / 5; turn++) {
  const callId = `call_${turn}`;
  input.push(
    ...freezeJsonSnapshot([
      {
        type: "message" as const,
        role: "user" as const,
        content: [{ type: "input_text" as const, text: `question ${turn} ${"u".repeat(1024)}` }],
      },
      {
        type: "function_call" as const,
        call_id: callId,
        name: "lookup",
        arguments: '{"q":"fixture"}',
      },
      {
        type: "function_call_output" as const,
        call_id: callId,
        output: `result ${turn} ${"t".repeat(2048)}`,
      },
      {
        type: "reasoning" as const,
        id: `rs_${turn}`,
        summary: [],
        encrypted_content: `sealed-${turn}-${"e".repeat(4096)}`,
      },
      {
        type: "message" as const,
        role: "assistant" as const,
        id: `msg_${turn}`,
        status: "completed" as const,
        content: [
          {
            type: "output_text" as const,
            text: `answer ${turn} ${"a".repeat(1024)}`,
            annotations: [],
          },
        ],
      },
    ]),
  );
}
input[0] = freezeJsonSnapshot({
  type: "compaction",
  id: "cmp_fixture",
  encrypted_content: "compacted-fixture",
});
function run(count: number) {
  for (let iteration = 0; iteration < count; iteration++) {
    owner.recordResponsesContextUsage(
      message,
      model,
      undefined,
      { input: input.slice() },
      [],
      "transport",
    );
  }
}
async function collect() {
  await nextTurn();
  globalThis.gc!();
  await nextTurn();
  globalThis.gc!();
  return process.memoryUsage().heapUsed;
}
const preparedHeap = values.retention ? await collect() : undefined;
run(10);
const expected = JSON.stringify(readResponsesInputReplayState(message)?.contextUsage);
if (values.retention) {
  const liveHeap = await collect();
  const references = input.map((item) => new WeakRef(item));
  input.length = 0;
  const releasedHeap = await collect();
  const collected = references.filter((entry) => entry.deref() === undefined).length;
  assert.equal(collected, references.length);
  assert(preparedHeap !== undefined);
  console.log(
    JSON.stringify({
      mode: "retention",
      items,
      preparedHeap,
      liveHeap,
      releasedHeap,
      cacheGrowth: liveHeap - preparedHeap,
      collected,
      hostLoad: loadavg(),
    }),
  );
  process.exit(0);
}
globalThis.gc();
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const gc = new GCProfiler();
gc.start();
const hostLoadBefore = loadavg();
const memoryBefore = process.memoryUsage();
const cpuBefore = process.threadCpuUsage();
const start = performance.now();
run(iterations);
const wallMs = performance.now() - start;
const cpu = process.threadCpuUsage(cpuBefore);
const memoryAfter = process.memoryUsage();
const collections = gc.stop()?.statistics ?? [];
let sampledBytes: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
assert.equal(JSON.stringify(readResponsesInputReplayState(message)?.contextUsage), expected);
console.log(
  JSON.stringify({
    ownerSha256: hash("sha256", readFileSync(modulePath)),
    mode: values.allocation ? "allocation" : "timing",
    node: process.version,
    items,
    iterations,
    wallMs,
    mainThreadCpuUsPerRequest: (cpu.user + cpu.system) / iterations,
    sampledBytesPerRequest: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    gc: summarizeGcByKind(collections),
    memoryBefore,
    memoryAfter,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    contextUsage: expected,
  }),
);
