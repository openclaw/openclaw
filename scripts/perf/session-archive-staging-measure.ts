/**
 * Archive materialization owner benchmark; existing offline synthetic state only.
 * node --import ./scripts/tsx.mjs scripts/perf/session-archive-staging-measure.ts
 *   --state-dir .local/team-state --iterations 2000 --output .local/base.json
 *   [--owner-dir /absolute/source-overlay]
 * Overlay src/config/sessions/session-accessor.sqlite-archive.worker.ts with the
 * pinned baseline bytes; omit --owner-dir for candidate. Both use the same loader.
 * Alternate baseline/candidate launches against the same undeleted session 800.
 * This invokes the worker owner in this process, excluding worker startup/IPC,
 * deletion, and durable archive publication. It does not measure Gateway latency.
 * CPU/allocation/GC describe this isolate; zstd/native allocation is not included.
 * fsync timing is real, with no injected delay. Natural GC is observed, not forced.
 * Preparation and byte-for-byte source/archive verification are outside timing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GCProfiler, getHeapStatistics } from "node:v8";
import { zstdDecompressSync } from "node:zlib";
import type { DB } from "../../src/state/openclaw-agent-db.generated.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "owner-dir": { type: "string" },
    iterations: { type: "string", default: "2000" },
    output: { type: "string" },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and a new --output JSON are required");
const root = fs.realpathSync(values["state-dir"]);
const output = path.resolve(values.output);
const fixture = JSON.parse(fs.readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(fixture.format, "openclaw-team-shape-v1", "Never use live state");
assert(fixture.sessionCount > 800, "Fixture must contain session index 800");
assert(!fs.existsSync(output), "Output already exists");
if (values["owner-dir"]) {
  assert(
    fs
      .statSync(
        path.join(
          values["owner-dir"],
          "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
        ),
      )
      .isFile(),
    "--owner-dir must contain the baseline archive worker",
  );
}
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "Invalid --iterations");
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
  OPENCLAW_BENCH_BASELINE_DIR: values["owner-dir"]
    ? path.resolve(values["owner-dir"])
    : path.join(root, ".archive-staging-no-overlay"),
};
assert(values["owner-dir"] || !fs.existsSync(process.env.OPENCLAW_BENCH_BASELINE_DIR!));
await import("./worker-retained-heap-preload.ts");
const [owner, readOnly, snapshots, sql, payload, agentDb, stateDb, lifecycle] = await Promise.all([
  import("../../src/config/sessions/session-accessor.sqlite-archive.worker.ts"),
  import("../../src/state/openclaw-agent-db-readonly-open.ts"),
  import("../../src/config/sessions/session-accessor.sqlite-delete-snapshot.ts"),
  import("../../src/infra/kysely-sync.ts"),
  import("../../src/config/sessions/transcript-payload-read.ts"),
  import("../../src/state/openclaw-agent-db.ts"),
  import("../../src/state/openclaw-state-db.ts"),
  import("../../src/shared/global-singleton.ts"),
]);
const sessionId = "team-shape-session-800";
const archiveDirectory = path.join(root, "agents", "main", "sessions");
const capture = () => {
  const opened = readOnly.withFreshOpenClawAgentDatabaseReadOnly(
    (database) => {
      const plan = snapshots.planSessionStateDeleteIfUnreferenced({
        database,
        sessionId,
        archiveDirectory,
        archiveTranscript: true,
        referencedSessionIds: new Set(),
      });
      assert(
        plan?.snapshot.sessionKey && plan.snapshot.lastSeq !== null,
        "Session was removed/cold",
      );
      const query = sql.getNodeSqliteKysely<DB>(database.db);
      const node = sql.executeSqliteQuerySync(
        database.db,
        query
          .selectFrom("session_nodes")
          .select("session_key")
          .where("session_key", "=", plan.snapshot.sessionKey),
      ).rows;
      assert.equal(node.length, 1, "Source session was deleted");
      const rows = sql.executeSqliteQuerySync(
        database.db,
        query
          .selectFrom("transcript_events")
          .select(payload.transcriptEventJsonSql(database.db).as("event_json"))
          .where("session_id", "=", sessionId)
          .orderBy("seq"),
      ).rows;
      return { plan, jsonl: rows.map((row) => `${row.event_json}\n`).join(""), rows: rows.length };
    },
    { agentId: "main", env: process.env },
  );
  assert(opened.found, "Fixture database is missing");
  return opened.value;
};
const originalFsync = fs.fsyncSync;
try {
  const before = capture();
  const verify = (
    result: Awaited<ReturnType<typeof owner.materializeTranscriptArchiveInWorker>>,
  ) => {
    assert(result.archive, "Expected encoded archive");
    const bytes = Buffer.from(result.archive.bytes);
    assert.equal(
      (result.archive.encoding === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8"),
      before.jsonl,
    );
  };
  let result = await owner.materializeTranscriptArchiveInWorker(before.plan, process.env);
  verify(result);
  let fsyncCount = 0;
  let fsyncMs = 0;
  fs.fsyncSync = (fd) => {
    const started = performance.now();
    try {
      return originalFsync(fd);
    } finally {
      fsyncCount++;
      fsyncMs += performance.now() - started;
    }
  };
  syncBuiltinESMExports();
  const durations: number[] = [];
  const gc = new GCProfiler();
  const loadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  gc.start();
  const allocatedBefore = getHeapStatistics().total_allocated_bytes;
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    const operationStarted = performance.now();
    result = await owner.materializeTranscriptArchiveInWorker(before.plan, process.env);
    durations.push(performance.now() - operationStarted);
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  const allocatedAfter = getHeapStatistics().total_allocated_bytes;
  const collections = gc.stop()?.statistics ?? [];
  const memoryAfter = process.memoryUsage();
  const loadAfter = loadavg();
  fs.fsyncSync = originalFsync;
  syncBuiltinESMExports();
  verify(result);
  assert.deepEqual(capture(), before, "Materialization changed source state");
  const percentile = (measurements: number[], p: number) =>
    measurements.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(measurements.length * p) - 1)] ??
    0;
  const allocatedBytes =
    Number.isFinite(allocatedBefore) && Number.isFinite(allocatedAfter)
      ? allocatedAfter - allocatedBefore
      : null;
  const totalGcMs = collections.reduce((sum, collection) => sum + collection.cost / 1000, 0);
  const summary = {
    format: "session-archive-staging-v1",
    node: process.version,
    ownerDir: values["owner-dir"] ?? null,
    sessionId,
    fixtureSessions: fixture.sessionCount,
    transcriptRows: before.rows,
    transcriptBytes: Buffer.byteLength(before.jsonl),
    iterations,
    elapsedMs,
    wall: {
      samples: durations.length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
    },
    threadCpuMs: (cpu.user + cpu.system) / 1000,
    allocatedBytes,
    allocatedBytesPerOperation: allocatedBytes === null ? null : allocatedBytes / iterations,
    allocatedBytesPerSecond: allocatedBytes === null ? null : allocatedBytes / (elapsedMs / 1000),
    fsync: { count: fsyncCount, totalMs: fsyncMs },
    gcMsPerMinute: (totalGcMs * 60000) / elapsedMs,
    gc: [...new Set(collections.map((entry) => entry.gcType))].map((kind) => {
      const pauses = collections
        .filter((entry) => entry.gcType === kind)
        .map((entry) => entry.cost / 1000);
      return {
        kind,
        samples: pauses.length,
        totalMs: pauses.reduce((sum, ms) => sum + ms, 0),
        p95Ms: percentile(pauses, 0.95),
        p99Ms: percentile(pauses, 0.99),
        maxMs: Math.max(0, ...pauses),
      };
    }),
    loadBefore,
    loadAfter,
    memoryBefore,
    memoryAfter,
    correctness:
      "Encoded bytes match original JSONL; session row, snapshot and transcript unchanged",
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(summary));
} finally {
  fs.fsyncSync = originalFsync;
  syncBuiltinESMExports();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
  await lifecycle.drainGlobalSingletonLifecycleState("close");
  await (await import("esbuild")).stop();
}
