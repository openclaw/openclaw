/**
 * Real SQLite Board snapshot benchmark, with a controlled unrelated writer backlog.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/board-read-admission-measure.ts \
 *   --store-module src/boards/sqlite-board-store.ts --iterations 2000 --samples 200 --hold-ms 20
 * Run base/candidate in AB/BA order. A pristine store-module copy must live beside
 * sqlite-board-store.ts. For an admission change, also copy the baseline
 * openclaw-agent-write-admission.ts beside its source and remap the copied
 * store's admission import to that copy; other dependencies stay identical. Synthetic
 * state (10k session rows, 24 HTML widgets) is created under .local and removed on exit.
 * The held reservation models writer backlog; its artificial delay is not a
 * reproduction of the reported 70-second latency. The callback commits an
 * unrelated session update before releasing the production writer admission.
 * Timing and main-thread sampled allocation are separate warm passes. Worker
 * request duration includes SQLite, presentation and transport; no SQL-only
 * timing is claimed. This measures the store, observer projection and JSON,
 * not RPC authorization, HTML tickets, sockets or model turns.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "store-module": { type: "string", default: "src/boards/sqlite-board-store.ts" },
    iterations: { type: "string", default: "2000" },
    samples: { type: "string", default: "200" },
    "hold-ms": { type: "string", default: "20" },
  },
});
const iterations = Number(values.iterations);
const samples = Number(values.samples);
const holdMs = Number(values["hold-ms"]);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(samples) && samples >= 200, "p95 needs at least 200 samples");
assert(Number.isFinite(holdMs) && holdMs > 0);
assert(globalThis.gc, "run with --expose-gc");
const modulePath = resolve(values["store-module"]);
const scratch = resolve(".local");
mkdirSync(scratch, { recursive: true });
const stateDir = mkdtempSync(`${scratch}/board-read-measure-`);
process.env.OPENCLAW_STATE_DIR = stateDir;

const [storeModule, agentDb, stateDb, entry, admission, transactions, diagnostics, metrics, board] =
  await Promise.all([
    import(pathToFileURL(modulePath).href) as Promise<
      typeof import("../../src/boards/sqlite-board-store.js")
    >,
    import("../../src/state/openclaw-agent-db.js"),
    import("../../src/state/openclaw-state-db.js"),
    import("../../src/config/sessions/session-accessor.entry.js"),
    import("../../src/state/openclaw-agent-write-admission.js"),
    import("../../src/infra/sqlite-transaction.js"),
    import("../../src/infra/diagnostic-events.js"),
    import("../../src/infra/worker-request-diagnostics.js"),
    import("../../src/gateway/server-methods/board-handler-context.js"),
  ]);

function distribution(observations: readonly number[]) {
  const sorted = observations.toSorted((a, b) => a - b);
  return {
    n: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}

try {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const database = agentDb.openOpenClawAgentDatabase({ agentId: "main", env });
  const options = { agentId: "main", path: database.path, env };
  const target = { agentId: "main", sessionKey: "agent:main:dashboard" };
  entry.replaceSessionEntrySync(
    { ...options, storePath: database.path, sessionKey: target.sessionKey },
    { sessionId: "dashboard-session", updatedAt: 1 },
  );
  // Bulk fixture insertion deliberately excludes per-row runtime publication work.
  const insert = database.db.prepare(
    "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, status) VALUES (?, ?, ?, 1, 'done')",
  );
  transactions.runSqliteImmediateTransactionSync(database.db, () => {
    for (let index = 1; index < 10_000; index++) {
      const sessionId = `synthetic-${index}`;
      insert.run(
        `agent:main:subagent:${index}`,
        sessionId,
        JSON.stringify({ sessionId, updatedAt: 1, status: "done", archivedAt: 1 }),
      );
    }
  });
  const store = new storeModule.SqliteBoardStore({
    resolveSession: (selected) => ({ ...options, sessionKey: selected.sessionKey }),
    env,
  });
  await store.applyOps(
    target,
    Array.from({ length: 4 }, (_, index) => ({
      kind: "tab_create" as const,
      tabId: `tab-${index}`,
      title: `Group ${index}`,
    })),
  );
  for (let index = 0; index < 24; index++) {
    await store.putWidget({
      ...target,
      name: `widget-${index}`,
      placement: { tabId: `tab-${index % 4}` },
      content: { kind: "html", html: `<p>Synthetic widget ${index}</p>` },
    });
  }
  const expected = await store.getSnapshotWithHtmlViewMetadata(target);
  assert.equal(expected.snapshot.widgets.length, 24);
  assert.equal(expected.htmlViewMetadata.size, 24);
  const digest = createHash("sha256")
    .update(JSON.stringify(expected.snapshot.widgets.map(({ name, tabId }) => ({ name, tabId }))))
    .digest("hex");
  const phases = {
    readMs: [] as number[],
    projectionMs: [] as number[],
    serializationMs: [] as number[],
  };
  let sink = 0;
  let activeReadStarted = 0;
  async function read(record = false) {
    const started = performance.now();
    activeReadStarted = started;
    const result = await store.getSnapshotWithHtmlViewMetadata(target);
    const readAt = performance.now();
    const projected = board.projectBoardSnapshot(result.snapshot, target.agentId);
    const projectedAt = performance.now();
    const serialized = JSON.stringify(projected);
    const ended = performance.now();
    assert.equal(result.snapshot.revision, expected.snapshot.revision);
    assert.equal(result.snapshot.widgets.length, 24);
    sink += serialized.length;
    if (record) {
      phases.readMs.push(readAt - started);
      phases.projectionMs.push(projectedAt - readAt);
      phases.serializationMs.push(ended - projectedAt);
    }
    return ended - started;
  }
  for (let index = 0; index < 20; index++) {
    await read();
  }
  const workerQueueMs: number[] = [];
  const workerRequestMs: number[] = [];
  const hostPreparationAndAdmissionMs: number[] = [];
  diagnostics.setDiagnosticsEnabledForProcess(true);
  const stopMetrics = metrics.onWorkerRequestMetrics(
    (kind, _request, phase, _depth, queue, duration) => {
      if (kind !== "sessionTranscript") {
        return;
      }
      if (phase === "started" && queue !== undefined) {
        workerQueueMs.push(queue);
        hostPreparationAndAdmissionMs.push(performance.now() - activeReadStarted - queue);
      }
      if (phase === "completed" && duration !== undefined) {
        workerRequestMs.push(duration);
      }
    },
  );
  const contended: number[] = [];
  const writerHeldMs: number[] = [];
  const loadBefore = loadavg();
  const update = database.db.prepare(
    "UPDATE session_nodes SET updated_at = ? WHERE session_key = 'agent:main:subagent:1'",
  );
  try {
    for (let index = 0; index < samples; index++) {
      const entered = Promise.withResolvers<void>();
      const writer = admission.runOpenClawAgentWorkerWrite(options, async () => {
        const started = performance.now();
        entered.resolve();
        await delay(holdMs);
        transactions.runSqliteImmediateTransactionSync(database.db, () => update.run(index + 2));
        writerHeldMs.push(performance.now() - started);
      });
      await entered.promise;
      try {
        contended.push(await read(true));
      } finally {
        await writer;
      }
    }
  } finally {
    stopMetrics();
    diagnostics.setDiagnosticsEnabledForProcess(false);
  }
  globalThis.gc();
  const cpuBefore = process.threadCpuUsage();
  const warmStarted = performance.now();
  for (let index = 0; index < iterations; index++) {
    await read();
  }
  const warmMs = performance.now() - warmStarted;
  const cpu = process.threadCpuUsage(cpuBefore);
  globalThis.gc();
  const inspector = new Session();
  inspector.connect();
  let sampledBytes = 0;
  try {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let index = 0; index < iterations; index++) {
      await read();
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
  } finally {
    inspector.disconnect();
  }
  console.log(
    JSON.stringify({
      sourceSha256: createHash("sha256").update(readFileSync(modulePath)).digest("hex"),
      node: process.version,
      sessions: 10_000,
      widgets: 24,
      iterations,
      holdMs,
      contendedMs: distribution(contended),
      writerHeldMs: distribution(writerHeldMs),
      phases: Object.fromEntries(
        Object.entries(phases).map(([key, observations]) => [key, distribution(observations)]),
      ),
      hostPreparationAndAdmissionMs: distribution(hostPreparationAndAdmissionMs),
      workerQueueMs: distribution(workerQueueMs),
      workerRequestMs: distribution(workerRequestMs),
      warm: {
        wallUsPerCall: (warmMs * 1000) / iterations,
        mainThreadCpuUsPerCall: (cpu.user + cpu.system) / iterations,
        mainThreadSampledBytesPerCall: sampledBytes / iterations,
      },
      memory: process.memoryUsage(),
      hostLoadBefore: loadBefore,
      hostLoadAfter: loadavg(),
      digest,
      sink,
    }),
  );
} finally {
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
  rmSync(stateDir, { recursive: true, force: true });
}
