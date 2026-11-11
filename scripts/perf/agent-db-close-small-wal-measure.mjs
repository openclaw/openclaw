/**
 * Native agent retirement with a large synthetic database and a small, freshly written WAL.
 * Seed: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/derived-index-admission-measure.ts
 *   --mode seed --state-dir .local/close-fixture --rows 1000000 --payload-bytes 36864
 * Measure: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-db-close-small-wal-measure.mjs
 *   --root .local/close-fixture --worker --scatter --shared-reader --samples 5
 * Run unchanged baseline/candidate sources serially in AB/BA order, plus A/A controls.
 * --allocation samples main-isolate JS only; process CPU includes workers, not child processes.
 * Native pragma tracing includes worker retirement. --profile records main-isolate CPU.
 * Acceptance: eliminate the shared-reader busy wait, preserve rows/seals, no CPU/allocation regression.
 * --arm planner measures already-bounded planner work separately; it is not part of normal close.
 * Warm filesystem caches; no full Gateway, cold-cache, btrfs or production attribution claim.
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
    arm: { type: "string", default: "close" },
    mib: { type: "string", default: "28" },
    samples: { type: "string", default: "5" },
    profile: { type: "boolean", default: false },
    allocation: { type: "boolean", default: false },
    scatter: { type: "boolean", default: false },
    worker: { type: "boolean", default: false },
    "shared-reader": { type: "boolean", default: false },
  },
});
assert(["close", "truncate", "passive", "pinned", "planner", "paired"].includes(values.arm));
assert(globalThis.gc, "Run with --expose-gc");
assert(Number.isSafeInteger(Number(values.samples)) && Number(values.samples) > 0);
assert(Number.isFinite(Number(values.mib)) && Number(values.mib) > 0 && Number(values.mib) <= 1024);
assert(values.root, "--root must name a synthetic derived-index-admission seed");
const root = path.resolve(values.root);
assert(fs.existsSync(path.join(root, "seed-proof.json")), "Only a synthetic seed is accepted");
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_LOG_LEVEL = "silent";
const sourceUrl = (p) => pathToFileURL(path.resolve(p)).href;
const traceBuffer = new SharedArrayBuffer((2 + 2048 * 6) * 4);
const traceView = new Int32Array(traceBuffer);
const preload = sourceUrl("scripts/perf/agent-db-close-small-wal-trace.mjs");
install(traceBuffer, root);
Object.assign(globalThis, {
  __agentCloseMeasureTrace: traceBuffer,
  __agentCloseMeasureRoot: root,
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
        `if(globalThis.__agentCloseMeasureTrace) options={...options,execArgv:[...(options?.execArgv??[]),'--import',globalThis.__agentCloseMeasurePreload],workerData:{...options?.workerData,agentCloseTrace:globalThis.__agentCloseMeasureTrace,agentCloseRoot:globalThis.__agentCloseMeasureRoot}}; ${before}`,
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
const opts = {
  agentId: "main",
  path: path.join(root, "agent.sqlite"),
  env: { ...process.env, OPENCLAW_STATE_DIR: root },
};
const inspector = new Session();
if (values.profile || values.allocation) {
  inspector.connect();
}
const sourceHash = createHash("sha256")
  .update(fs.readFileSync("src/state/openclaw-state-db-handle.ts"))
  .digest("hex");
const requestedArm = values.arm;
try {
  const seeded = owner.openOpenClawAgentDatabase(opts);
  assert.equal(seeded.db.prepare("SELECT count(*) AS n FROM session_nodes").get().n, 10000);
  assert.equal(seeded.db.prepare("SELECT count(*) AS n FROM transcript_events").get().n, 1000000);
  await owner.closeOpenClawAgentDatabasesAsync(root);
  for (let n = 0; n < Number(values.samples); n++) {
    if (requestedArm === "paired") {
      values.arm = ["close", "truncate", "truncate", "close"][n % 4];
    }
    const database = owner.openOpenClawAgentDatabase(opts);
    await database.walMaintenance.stop();
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
    owner.runOpenClawAgentWriteTransaction(() => {
      const write = database.db.prepare(
        "UPDATE transcript_events SET event_json=? WHERE session_id=? AND seq=?",
      );
      for (let i = 0; i < count; i++) {
        const row = values.scatter ? Math.floor((i * 1000000) / count) : i;
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
          `synthetic-${row % 10000}`,
          Math.floor(row / 10000) + 1,
        );
        assert.equal(Number(result.changes), 1);
      }
    }, opts);
    const walBefore = fs.statSync(`${opts.path}-wal`).size;
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
    assert.equal(database.db.isOpen, false);
    assert.equal(sealed, values.arm !== "pinned");
    if (reader) {
      reader.close();
      owner.openOpenClawAgentDatabase(opts);
      await owner.closeOpenClawAgentDatabasesAsync(root);
      assert(admission.readSqliteDatabaseCleanClose(opts.path));
    }
    sharedReader?.close();
    await execution?.release();
    const trace = Array.from({ length: Math.min(Atomics.load(traceView, 1), 2048) }, (_, i) => {
      const off = 2 + i * 6;
      return {
        thread: traceView[off],
        store: traceView[off + 5] === 1 ? "agent" : "shared",
        operation: labels[traceView[off + 1]],
        ms: traceView[off + 2] / 1000,
        cpuMs: traceView[off + 3] / 1000,
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
      databaseBytes: fs.statSync(opts.path).size,
      walBefore,
      closeMs,
      passiveMs,
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      allocatedBytes,
      sealed,
      load: loadavg(),
    };
    console.log(JSON.stringify(row));
  }
} finally {
  await owner.closeOpenClawAgentDatabasesAsync(root);
  await state.closeOpenClawStateDatabaseAsync();
  if (values.profile || values.allocation) {
    inspector.disconnect();
  }
}
