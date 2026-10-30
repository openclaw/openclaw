/**
 * Synthetic memory history projection reads over 10,000 small transcript messages.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-anchor-page-measure.ts \
 *   --iterations 2000 --mode timing [--baseline-dir <absolute-source-overlay>]
 * Repeat with --mode allocation in separate alternating baseline/candidate processes.
 * The shared preload substitutes every saved source path, including src/gateway/ and
 * src/sessions/. Save all changed production files at the baseline revision in the overlay.
 * Prepared rows use the canonical memory-state shape; this measures the production projection
 * owner, not actor mutation, transport or a Gateway. Seeding/warmup are excluded; phase timestamps
 * go to stderr. Older/newer/around-id fitting pages share the workload.
 * A 60-second measurement deadline bounds each run. If completedOperations differs, rerun
 * both arms with --iterations set to the smaller count before comparing CPU/allocation per op.
 * Report ordinary-path overhead, not a speedup: oversized-page correctness lives in tests.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    mode: { type: "string", default: "timing" },
    "baseline-dir": { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.mode === "timing" || values.mode === "allocation");
assert(globalThis.gc, "Run with --expose-gc");
const bootedAt = performance.now();
const phase = (name: string) =>
  console.error(
    JSON.stringify({
      phase: name,
      elapsedMs: performance.now() - bootedAt,
      at: new Date().toISOString(),
    }),
  );
phase("import");
const baseline = values["baseline-dir"] && path.resolve(values["baseline-dir"]);
const sourceDigests = Object.fromEntries(
  [
    "src/config/sessions/session-actor-memory-history-projection.ts",
    "src/sessions/transcript-anchor-page.ts",
    "src/gateway/session-transcript-source-pages.ts",
  ].map((relative) => {
    const saved = baseline && path.join(baseline, relative);
    const source =
      saved && existsSync(saved)
        ? saved
        : fileURLToPath(new URL(`../../${relative}`, import.meta.url));
    return [relative, createHash("sha256").update(readFileSync(source)).digest("hex")];
  }),
);
if (baseline) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = baseline;
  await import("./worker-retained-heap-preload.ts");
}
const { createSessionActorMemoryState } =
  await import("../../src/config/sessions/session-actor-memory-state.js");
const { readSessionActorMemoryProjection } =
  await import("../../src/config/sessions/session-actor-memory-history-projection.js");
phase("seed");
const sessionId = "synthetic-anchor-measure";
const messages = 10_000;
const state = createSessionActorMemoryState({
  database: { kind: "memory", handle: "synthetic-owner", incarnation: "synthetic-incarnation" },
  sessionKey: "agent:main:dashboard:incognito-anchor-measure",
});
state.hot.entry = { sessionId, updatedAt: 1, incognito: true };
state.hot.transcript.version = {
  generation: "synthetic-generation",
  rawSeq: messages,
  updatedAt: 1,
};
state.hot.transcript.watermark = { generation: "synthetic-generation", maxSeq: messages };
const fixtureDigest = createHash("sha256");
state.events = [
  { type: "session", id: sessionId, version: 3, cwd: "/synthetic" },
  ...Array.from({ length: messages }, (_, index) => ({
    type: "message",
    id: `row-${index}`,
    parentId: index ? `row-${index - 1}` : null,
    timestamp: "2026-10-11T00:00:00.000Z",
    message: { role: index % 2 ? "assistant" : "user", content: "Synthetic content. ".repeat(8) },
  })),
].map((event, rawSeq) => {
  const eventJson = JSON.stringify(event);
  fixtureDigest.update(eventJson);
  return { rawSeq, event, eventJson };
});
phase("warmup");
const queries = (["older", "newer", undefined] as const).map((direction) => ({
  kind: "around-id" as const,
  options: { messageId: "row-5000", maxMessages: 40, direction },
}));
const scope = { agentId: "main", path: ":memory:anchor-measure" };
const read = (index: number) => {
  const page = readSessionActorMemoryProjection(state, scope, queries[index % queries.length]!);
  assert(
    typeof page === "object" &&
      page !== null &&
      "messages" in page &&
      "found" in page &&
      page.found,
  );
  return page;
};
for (let index = 0; index < 3; index++) {
  const page = read(index);
  assert(page.found);
  assert.equal(page.messages.length, index % 3 === 2 ? 41 : 40);
}
globalThis.gc();
const inspector = values.mode === "allocation" ? new Session() : undefined;
if (inspector) {
  await startCollectedHeapSampling(inspector, 262_144);
}
const profiler = new GCProfiler();
profiler.start();
const hostLoadBefore = loadavg();
const memoryBefore = process.memoryUsage();
phase("measure");
const cpu = process.threadCpuUsage();
const started = performance.now();
let completedOperations = 0;
let returnedMessages = 0;
for (; completedOperations < iterations; completedOperations++) {
  if (performance.now() - started >= 60_000) {
    break;
  }
  returnedMessages += read(completedOperations).messages.length;
}
const elapsedMs = performance.now() - started;
const cpuUsage = process.threadCpuUsage(cpu);
phase("complete");
const gc = profiler.stop()?.statistics ?? [];
const sampledBytes = inspector
  ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
  : undefined;
inspector?.disconnect();
console.log(
  JSON.stringify({
    sourceDigests,
    fixtureDigest: fixtureDigest.digest("hex"),
    boundary: "memory-history-projection",
    mode: values.mode,
    node: process.version,
    messages,
    requestedOperations: iterations,
    completedOperations,
    returnedMessages,
    elapsedMs,
    deadlineReached: completedOperations !== iterations,
    cpuUsPerOperation: (cpuUsage.user + cpuUsage.system) / completedOperations,
    sampledBytesPerOperation:
      sampledBytes === undefined ? undefined : sampledBytes / completedOperations,
    allocationIncludesCollectedObjects: values.mode === "allocation",
    gc: {
      count: gc.length,
      totalMs: gc.reduce((sum, row) => sum + row.cost / 1000, 0),
      maxMs: Math.max(0, ...gc.map((row) => row.cost / 1000)),
      byKind: Object.fromEntries(
        [...new Set(gc.map((row) => row.gcType))].map((kind) => {
          const rows = gc.filter((row) => row.gcType === kind);
          return [
            kind,
            {
              count: rows.length,
              totalMs: rows.reduce((sum, row) => sum + row.cost / 1000, 0),
              maxMs: Math.max(0, ...rows.map((row) => row.cost / 1000)),
            },
          ];
        }),
      ),
    },
    memoryBefore,
    memoryAfter: process.memoryUsage(),
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  }),
);
