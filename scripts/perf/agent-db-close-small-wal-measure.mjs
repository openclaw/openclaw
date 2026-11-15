/**
 * Native agent retirement with a large synthetic database and a small, freshly written WAL.
 * Seed: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/derived-index-admission-measure.ts
 *   --mode seed --state-dir .local/close-fixture --rows 1000000 --payload-bytes 36864
 * Measure: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-db-close-small-wal-measure.mjs
 *   --root .local/close-fixture --worker --scatter --shared-reader --samples 5
 * Add --shutdown --history-readers to fence admission with worker leases/readers held.
 * --database selects the agent file inside a synthetic team-shape fixture root.
 * A cloned fixture without verification receives a real FULL check before sampling.
 * Run unchanged baseline/candidate sources serially in AB/BA order, plus A/A controls.
 * --allocation samples main-isolate JS only; process CPU includes workers, not child processes.
 * Native pragma tracing includes worker retirement. --profile records main-isolate CPU.
 * A fix must reproduce its baseline wait, preserve rows/seals, and avoid CPU/allocation regressions.
 * --arm planner measures already-bounded planner work separately; it is not part of normal close.
 * Warm filesystem caches; this is the shutdown storage owner, not a full Gateway.
 * A btrfs fixture covers btrfs only on the measured host; production attribution needs its trace.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import { install, labels } from "./agent-db-close-small-wal-trace.mjs";
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    database: { type: "string", default: "agent.sqlite" },
    arm: { type: "string", default: "close" },
    mib: { type: "string", default: "28" },
    samples: { type: "string", default: "5" },
    profile: { type: "boolean", default: false },
    allocation: { type: "boolean", default: false },
    scatter: { type: "boolean", default: false },
    worker: { type: "boolean", default: false },
    "shared-reader": { type: "boolean", default: false },
    shutdown: { type: "boolean", default: false },
    "history-readers": { type: "boolean", default: false },
  },
});
assert(["close", "truncate", "passive", "pinned", "planner", "paired"].includes(values.arm));
assert(globalThis.gc, "Run with --expose-gc");
assert(Number.isSafeInteger(Number(values.samples)) && Number(values.samples) > 0);
assert(Number.isFinite(Number(values.mib)) && Number(values.mib) > 0 && Number(values.mib) <= 1024);
assert(values.root, "--root must name a synthetic derived-index-admission seed");
const root = fs.realpathSync(values.root);
const databasePath = fs.realpathSync(path.resolve(root, values.database));
assert(databasePath.startsWith(`${root}${path.sep}`), "--database must stay in the synthetic root");
assert(
  fs.existsSync(path.join(root, "seed-proof.json")) ||
    fs.existsSync(path.join(root, "team-shape-summary.json")),
  "Only a synthetic seed is accepted",
);
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_LOG_LEVEL = "silent";
const sourceUrl = (p) => pathToFileURL(path.resolve(p)).href;
const traceBuffer = new SharedArrayBuffer((2 + 2048 * 6) * 4);
const traceView = new Int32Array(traceBuffer);
const preload = sourceUrl("scripts/perf/agent-db-close-small-wal-trace.mjs");
install(traceBuffer, root, databasePath);
Object.assign(globalThis, {
  __agentCloseMeasureTrace: traceBuffer,
  __agentCloseMeasureRoot: root,
  __agentCloseMeasureDatabase: databasePath,
  __agentCloseMeasurePreload: preload,
});
registerHooks({
  load(url, context, next) {
    if (url === sourceUrl("src/infra/worker-cpu.ts")) {
      let code = fs.readFileSync(new URL(url), "utf8");
      const before = "const worker = runWithMainThreadTask(";
      assert.equal(code.split(before).length, 2);
      code = code.replace(
        before,
        `if(globalThis.__agentCloseMeasureTrace) options={...options,execArgv:[...(options?.execArgv??[]),'--import',globalThis.__agentCloseMeasurePreload],workerData:{...options?.workerData,agentCloseTrace:globalThis.__agentCloseMeasureTrace,agentCloseRoot:globalThis.__agentCloseMeasureRoot,agentClosePath:globalThis.__agentCloseMeasureDatabase}}; ${before}`,
      );
      return {
        format: "module",
        source: transformSync(code, { loader: "ts", format: "esm", target: "esnext" }).code,
        shortCircuit: true,
      };
    }
    return next(url, context);
  },
});
const owner = await import(sourceUrl("src/state/openclaw-agent-db.ts"));
const state = await import(sourceUrl("src/state/openclaw-state-db.ts"));
const admission = await import(sourceUrl("src/infra/sqlite-database-admission.ts"));
const { DatabaseSync } = await import("node:sqlite");
const shutdown = await import(sourceUrl("src/process/gateway-work-admission.ts"));
const opts = {
  agentId: "main",
  path: databasePath,
  env: { ...process.env, OPENCLAW_STATE_DIR: root },
};
const inspector = new Session();
if (values.profile || values.allocation) {
  inspector.connect();
}
const sourceDigest = createHash("sha256");
for (const file of [
  "src/state/openclaw-agent-db-close.ts",
  "src/state/openclaw-agent-db-lifecycle.ts",
  "src/state/openclaw-agent-db-resources.ts",
  "src/state/openclaw-agent-db-lease.ts",
  "src/state/openclaw-agent-execution-close.ts",
  "src/state/openclaw-state-db-handle.ts",
  "src/infra/sqlite-worker-broker-lifecycle.ts",
]) {
  sourceDigest.update(file).update(fs.readFileSync(file));
}
const sourceHash = sourceDigest.digest("hex");
const requestedArm = values.arm;
try {
  const seeded = owner.openOpenClawAgentDatabase(opts);
  if (!admission.readSqliteDatabaseIntegrityVerification(seeded.db)) {
    const { assertSqliteIntegrity } = await import(sourceUrl("src/infra/sqlite-integrity.ts"));
    assertSqliteIntegrity(seeded.db, "synthetic close fixture", { check: "full" });
  }
  const sessions = seeded.db.prepare("SELECT count(*) AS n FROM session_nodes").get().n;
  const events = seeded.db.prepare("SELECT count(*) AS n FROM transcript_events").get().n;
  const sessionKey = seeded.db
    .prepare("SELECT session_key FROM session_nodes LIMIT 1")
    .get()?.session_key;
  assert(sessions >= 10000 && events > 0, "Expected a populated synthetic fixture");
  await owner.closeOpenClawAgentDatabasesAsync(root);
  for (let n = 0; n < Number(values.samples); n++) {
    if (requestedArm === "paired") {
      values.arm = ["close", "truncate", "truncate", "close"][n % 4];
    }
    const database = owner.openOpenClawAgentDatabase(opts);
    if (!values.shutdown) {
      await database.walMaintenance.stop();
    }
    let execution;
    if (values.worker) {
      const { captureOpenClawAgentDatabaseExecution } = await import(
        sourceUrl("src/state/openclaw-agent-execution.ts")
      );
      const { createSessionWorkerExecutionSource } = await import(
        sourceUrl("src/config/sessions/session-worker-execution-source.ts")
      );
      execution = captureOpenClawAgentDatabaseExecution(opts);
      await execution.prepare(
        createSessionWorkerExecutionSource(() => {}, "synthetic close probe"),
      );
    }
    let sharedReader;
    const historyReaders = [];
    if (values["history-readers"]) {
      const { retainSessionHistoryWorkerDatabase } = await import(
        sourceUrl("src/config/sessions/session-transcript-worker-runtime.ts")
      );
      const { historyLane, projectionLane, maintenanceLane } = await import(
        sourceUrl("src/config/sessions/session-transcript-worker-resources.ts")
      );
      for (const lane of [historyLane, projectionLane, maintenanceLane]) {
        const held = retainSessionHistoryWorkerDatabase(opts, lane);
        historyReaders.push(held);
        assert(
          await held.owner.readEntryPresence({
            agentId: "main",
            databaseAgentId: "main",
            sessionKey,
            storePath: opts.path,
          }),
        );
      }
    }
    if (values["shared-reader"]) {
      const shared = state.openOpenClawStateDatabase({ env: opts.env });
      sharedReader = new DatabaseSync(shared.path, { readOnly: true });
      sharedReader.exec("BEGIN");
      sharedReader.prepare("SELECT count(*) FROM agent_database_leases").get();
    }
    let reader;
    if (values.arm === "pinned") {
      reader = new DatabaseSync(opts.path, { readOnly: true });
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) AS n FROM session_nodes").get();
    }
    database.db.exec("PRAGMA wal_autocheckpoint=0");
    const count = Math.ceil((Number(values.mib) * 1024 * 1024) / 36864);
    const bounds = database.db
      .prepare("SELECT min(rowid) AS first, max(rowid) AS last FROM transcript_events")
      .get();
    const selectRow = database.db.prepare(
      "SELECT session_id, seq FROM transcript_events WHERE rowid >= ? ORDER BY rowid LIMIT 1",
    );
    const selectedRows = Array.from({ length: count }, (_, i) =>
      selectRow.get(
        bounds.first +
          (values.scatter ? Math.floor((i * (bounds.last - bounds.first)) / count) : i),
      ),
    );
    owner.runOpenClawAgentWriteTransaction(() => {
      const write = database.db.prepare(
        "UPDATE transcript_events SET event_json=?, event_zstd=NULL, event_utf8_bytes=NULL, navigation_json=NULL WHERE session_id=? AND seq=?",
      );
      for (let i = 0; i < count; i++) {
        const row = selectedRows[i];
        const result = write.run(
          JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              content: [
                {
                  type: "text",
                  text: `${Date.now()}:${process.pid}:${n}:`.repeat(36864).slice(0, 36864),
                },
              ],
            },
          }),
          row.session_id,
          row.seq,
        );
        assert.equal(Number(result.changes), 1);
      }
    }, opts);
    const walBefore = fs.statSync(`${opts.path}-wal`).size;
    const shared = state.openOpenClawStateDatabase({ env: opts.env });
    const leaseCount = () =>
      shared.db
        .prepare("SELECT count(*) AS n FROM agent_database_leases WHERE path = ?")
        .get(opts.path).n;
    const leasesBefore = leaseCount();
    assert(leasesBefore >= (values.worker ? 2 : 1));
    globalThis.gc();
    if (values.profile) {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    if (values.allocation) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    traceView.fill(0);
    Atomics.store(traceView, 0, 1);
    const cpu = process.cpuUsage();
    const start = performance.now();
    if (values.shutdown) {
      // SIGTERM's owner fences new work before draining retained readers and writers.
      shutdown.markGatewayRestartDraining();
      shutdown.beginGatewayShutdownCleanup();
    }
    let passiveMs = 0;
    const pragmaResults = [];
    if (values.arm === "planner") {
      owner.runOpenClawAgentWriteTransaction(() => {
        for (const sql of [
          "PRAGMA analysis_limit=1000",
          "PRAGMA optimize=0x10002",
          "ANALYZE main",
        ]) {
          const t = performance.now();
          database.db.exec(sql);
          pragmaResults.push({ sql, ms: performance.now() - t });
        }
      }, opts);
    }
    if (["passive", "truncate"].includes(values.arm)) {
      const t = performance.now();
      database.db.prepare(`PRAGMA wal_checkpoint(${values.arm.toUpperCase()})`).get();
      passiveMs = performance.now() - t;
    }
    const closeStart = performance.now();
    await owner.closeOpenClawAgentDatabasesAsync(root);
    const closeMs = performance.now() - closeStart;
    const leasesAfter = leaseCount();
    Atomics.store(traceView, 0, 0);
    const used = process.cpuUsage(cpu);
    const elapsedMs = performance.now() - start;
    let allocatedBytes = null;
    if (values.allocation) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const sum = (node) =>
        node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
      allocatedBytes = sum(profile.head);
    }
    if (values.profile) {
      const { profile } = await inspector.post("Profiler.stop");
      fs.writeFileSync(
        path.join(root, `close-${values.arm}-${n}.cpuprofile`),
        JSON.stringify(profile),
      );
    }
    const sealed = admission.readSqliteDatabaseCleanClose(opts.path);
    if (reader) {
      reader.close();
      owner.openOpenClawAgentDatabase(opts);
      await owner.closeOpenClawAgentDatabasesAsync(root);
      assert(admission.readSqliteDatabaseCleanClose(opts.path));
    }
    sharedReader?.close();
    for (const held of historyReaders) {
      held.release();
    }
    await execution?.release();
    const trace = Array.from({ length: Math.min(Atomics.load(traceView, 1), 2048) }, (_, i) => {
      const off = 2 + i * 6;
      return {
        thread: traceView[off],
        store: ["lifecycle", "agent", "shared"][traceView[off + 5]],
        operation: labels[traceView[off + 1]],
        ms: traceView[off + 2] / 1000,
        cpuMs: traceView[off + 3] < 0 ? null : traceView[off + 3] / 1000,
        startedMs: traceView[off + 4] / 1000,
      };
    });
    const row = {
      sourceHash,
      sharedReader: values["shared-reader"],
      scatter: values.scatter,
      allocation: values.allocation,
      pragmaResults,
      trace,
      n,
      arm: values.arm,
      worker: values.worker,
      shutdown: values.shutdown,
      historyReaders: values["history-readers"],
      node: process.version,
      resourcesAfterAgentClose: process.getActiveResourcesInfo(),
      databaseBytes: fs.statSync(opts.path).size,
      sessions,
      events,
      walBefore,
      leasesBefore,
      leasesAfter,
      closeMs,
      passiveMs,
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      allocatedBytes,
      sealed,
      load: loadavg(),
    };
    console.log(JSON.stringify(row));
    assert.equal(database.db.isOpen, false);
    assert.equal(sealed, values.arm !== "pinned");
    assert.equal(leasesAfter, 0);
    if (values.shutdown) {
      shutdown.resetGatewayWorkAdmission();
    }
  }
} finally {
  await owner.closeOpenClawAgentDatabasesAsync(root);
  await state.closeOpenClawStateDatabaseAsync();
  if (values.profile || values.allocation) {
    inspector.disconnect();
  }
}
