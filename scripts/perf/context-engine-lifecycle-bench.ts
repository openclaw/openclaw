/**
 * Warm context-engine prompt preparation over eight synthetic sessions, each
 * with 256 messages, 40 tools, and 128 unrelated enclosing-attempt fields.
 * node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/context-engine-lifecycle-bench.ts --iterations 2000
 * Use --owner <path> for another revision of the owner (with resolvable imports).
 * Alternate base/candidate timing runs; --allocations measures collected-object
 * sampling separately. This measures the lifecycle owner, not Gateway latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { PerformanceObserver, type PerformanceNodeEntry } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ContextEngine } from "../../src/context-engine/types.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    owner: { type: "string", default: "src/agents/harness/context-engine-lifecycle.ts" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
const ownerUrl = pathToFileURL(resolve(values.owner));
const ownerSha256 = createHash("sha256").update(readFileSync(ownerUrl)).digest("hex");
const { prepareHarnessContextEnginePrompt } = (await import(
  ownerUrl.href
)) as typeof import("../../src/agents/harness/context-engine-lifecycle.js");
let engineCalls = 0;
const contextEngine: ContextEngine = {
  info: { id: "legacy", name: "Synthetic pass-through" },
  async ingest() {
    return { ingested: true };
  },
  async compact() {
    return { ok: true, compacted: false };
  },
  async assemble({ messages }) {
    engineCalls++;
    return { messages, estimatedTokens: 0 };
  },
};
const attempts = Array.from({ length: 8 }, (_attempt, session) => ({
  ...Object.fromEntries(Array.from({ length: 128 }, (_, field) => [`attemptField${field}`, field])),
  sessionId: `synthetic-${session}`,
  sessionKey: `agent:main:synthetic-${session}`,
  modelId: "synthetic-model",
  contextEngine,
  messages: Array.from({ length: 256 }, (_, index) => ({
    role: "user" as const,
    content: `Synthetic session ${session} message ${index}`,
    timestamp: index,
  })),
  availableTools: new Set(Array.from({ length: 40 }, (_, index) => `synthetic_tool_${index}`)),
  promptBudget: {
    contextTokens: 100_000,
    reserveTokens: 4096,
    systemPrompt: "Synthetic system instructions",
    prompt: "Continue synthetic work",
  },
  repairToolUseResultPairing: true,
  isOpenAIResponsesApi: false,
  warn: (message: string) => {
    throw new Error(message);
  },
}));
const fingerprint = createHash("sha256");
for (const attempt of attempts) {
  fingerprint.update(JSON.stringify(await prepareHarnessContextEnginePrompt(attempt)));
}
async function run(count: number) {
  for (let index = 0; index < count; index++) {
    await prepareHarnessContextEnginePrompt(attempts[index % attempts.length]!);
  }
}
await run(500);
engineCalls = 0;
global.gc();
await nextTurn();
const pauses: { kind: number; duration: number }[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    pauses.push({ kind: (entry as PerformanceNodeEntry).detail.kind, duration: entry.duration });
  }
});
const inspector = new Session();
try {
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    observer.observe({ entryTypes: ["gc"] });
  }
  const hostLoad = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  await run(iterations);
  const wallMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  let sampledBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  console.log(
    JSON.stringify({
      ownerSha256,
      iterations,
      engineCalls,
      sessions: attempts.length,
      messagesPerSession: 256,
      unrelatedAttemptFields: 128,
      tools: 40,
      mode: values.allocations ? "allocation" : "timing",
      node: process.version,
      fingerprint: fingerprint.digest("hex"),
      hostLoad,
      wallMs,
      mainThreadCpuMs: (used.user + used.system) / 1000,
      sampledBytes,
      bytesPerTurn: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      gc: values.allocations
        ? undefined
        : {
            count: pauses.length,
            totalMs: pauses.reduce((sum, pause) => sum + pause.duration, 0),
            maxMs: Math.max(0, ...pauses.map((pause) => pause.duration)),
            collections: pauses,
          },
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
}
