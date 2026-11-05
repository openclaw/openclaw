/**
 * Actor hydration after entry-only invalidation, on synthetic SQLite history.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-actor-accounting-reuse-measure.ts \
 *   --output .local/actor-accounting-base --iterations 1000 [--baseline-dir <overlay>]
 * Repeat alternating base/candidate, then separately with --mode allocation.
 * Overlay the changed accounting/hydration owner modules at their source paths.
 * Measures the real hydration owner with an unchanged transcript and previously owned
 * totals. Use --readmission for actor eviction/reacquisition on the same admitted
 * connection; --events controls history length (default 1024). The actor boundary
 * regression separately proves invalidation and append behavior.
 * Acceptance: identical hydrated facts, no repeated unchanged transcript-window load,
 * lower CPU/allocation, no material GC increase. Fresh/changed histories still load.
 * Setup and cleanup are excluded. Each run deletes its synthetic state; keeps result.json.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "baseline-dir": { type: "string" },
    iterations: { type: "string", default: "1000" },
    events: { type: "string", default: "1024" },
    readmission: { type: "boolean" },
    mode: { type: "string", default: "timing" },
  },
});
assert(values.output && typeof globalThis.gc === "function");
assert(values.mode === "timing" || values.mode === "allocation");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const eventCount = Number(values.events);
assert(Number.isSafeInteger(eventCount) && eventCount > 0);
const output = path.resolve(values.output);
mkdirSync(output);
const root = path.join(output, "state");
mkdirSync(root);
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), path.join(root, "config.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: root,
};
writeFileSync(path.join(root, "config.json"), JSON.stringify({ plugins: { enabled: false } }));
if (values["baseline-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["baseline-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  closeOpenClawAgentDatabasesAsync,
} = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { readOpenClawAgentDatabaseIdentity } =
  await import("../../src/state/openclaw-agent-db-identity.js");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { appendTranscriptEventsInTransaction } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
const { hydrateSessionActorState } =
  await import("../../src/config/sessions/session-actor-hydration.worker.js");
const options = { agentId: "main", env: process.env };
const inspector = new Session();
try {
  const database = openOpenClawAgentDatabase(options);
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:accounting-probe",
    sessionId: "synthetic-accounting",
    storePath: database.path,
  };
  const events = Array.from({ length: eventCount }, (_, index) => ({
    type: "message",
    id: `event-${index}`,
    parentId: index ? `event-${index - 1}` : null,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "user", content: `${index}:` + "x".repeat(8192) },
  }));
  runOpenClawAgentWriteTransaction(() => {
    writeSessionEntry(database, scope.sessionKey, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      skillsSnapshot: { prompt: "s".repeat(110_000), skills: [] },
    });
    appendTranscriptEventsInTransaction(database, scope, events, {
      scheduleProjectionReconcile: false,
    });
  }, options);
  const identity = readOpenClawAgentDatabaseIdentity(database);
  assert(typeof identity.identity === "string");
  const target = {
    sessionKey: scope.sessionKey,
    database: {
      kind: "file" as const,
      physicalIdentity: identity.identity,
      birthtime: identity.birthtime,
      nativeLocation: database.path,
    },
  };
  const version = { epoch: "synthetic", sequence: 0 };
  const previous = hydrateSessionActorState(database, target, version, "synthetic");
  const hydrate = () =>
    hydrateSessionActorState(
      database,
      target,
      version,
      "synthetic",
      values.readmission ? undefined : previous,
    );
  assert.deepEqual(hydrate(), previous);
  assert(previous.transcript.contextStats);
  assert.equal(previous.transcript.contextStats?.eventCount, events.length);
  assert.equal(
    previous.transcript.contextStats?.sizeBytes,
    events.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1, 0),
  );
  for (let i = 0; i < 20; i++) {
    hydrate();
  }
  globalThis.gc();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const gc = new GCProfiler();
  gc.start();
  const hostLoad = { before: loadavg(), after: [] as number[] };
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    hydrate();
  }
  const elapsedMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  const gcProfile = gc.stop();
  hostLoad.after = loadavg();
  const profile =
    values.mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  const result = {
    mode: values.mode,
    readmission: Boolean(values.readmission),
    iterations,
    historyEvents: events.length,
    historyBytes: previous.transcript.contextStats.sizeBytes,
    transcriptDigest: createHash("sha256")
      .update(JSON.stringify(previous.transcript.navigation))
      .digest("hex"),
    elapsedMs,
    cpuMs: (used.user + used.system) / 1000,
    sampledAllocationBytes: profile ? sumSampledHeapBytes(profile.profile.head) : undefined,
    gcProfile,
    hostLoad,
    memory: process.memoryUsage(),
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      mode: result.mode,
      iterations,
      elapsedMs,
      cpuMs: result.cpuMs,
      sampledAllocationBytes: result.sampledAllocationBytes,
    }),
  );
} finally {
  inspector.disconnect();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  rmSync(root, { recursive: true });
}
