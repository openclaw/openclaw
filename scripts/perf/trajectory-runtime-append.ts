/**
 * Synthetic trajectory append owner benchmark; no Gateway or real user state.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/trajectory-runtime-append.ts \
 *   --state-dir "$PWD/.local/trajectory-append-candidate" --iterations 200 --mode timing
 * Repeat with fresh directories and --mode allocation or counts. Only timing mode
 * measures untraced CPU/transaction holds; counts instruments native iterator rows.
 * Defaults: 10,000 sessions, 30 events per cold session, a full 10 MiB hot window.
 * --hot-sessions 21 interleaves full windows through the physical owner facts cache.
 * Use --iterations 2000 for longer passes. Alternate base/candidate launch order.
 * For a sparse baseline overlay, preserve changed modules at repository-relative
 * paths, set OPENCLAW_BENCH_BASELINE_DIR, and add
 * --import ./scripts/perf/worker-retained-heap-preload.ts after the TSX preload.
 * Seeding, warmup, forced GC, query plans, and readback are outside measurement.
 * This exercises the actual append owner and transaction boundary, not transport,
 * worker queueing, or active global retention. Sampled allocation includes GC'd objects.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { TrajectoryRuntimeWindowFacts } from "../../src/trajectory/runtime-store.contract.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "200" },
    sessions: { type: "string", default: "10000" },
    "hot-sessions": { type: "string", default: "1" },
    variant: { type: "string", default: "candidate" },
  },
});
assert(global.gc, "Use --expose-gc");
assert(values["state-dir"], "Use a new isolated --state-dir");
assert(["timing", "allocation", "counts"].includes(values.mode));
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 200,
  min: 1,
  label: "--iterations",
});
const sessions = parseStrictIntegerOption({
  raw: values.sessions,
  fallback: 10000,
  min: 1,
  label: "--sessions",
});
const hotSessions = parseStrictIntegerOption({
  raw: values["hot-sessions"],
  fallback: 1,
  min: 1,
  label: "--hot-sessions",
});
assert(hotSessions <= sessions);
const root = path.resolve(values["state-dir"]);
assert(!fs.existsSync(root), "Refusing to reuse existing state");
for (const name of ["home", "tmp"]) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
}
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  TMPDIR: path.join(root, "tmp"),
});
const { replaceSessionEntry } = await import("../../src/config/sessions/session-accessor.js");
const {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  closeOpenClawAgentDatabasesAsync,
} = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { appendSqliteTrajectoryRuntimeEventsWithWriter: append } =
  await import("../../src/trajectory/runtime-store.sqlite.js");
const {
  takeTrajectoryRuntimeWindowFacts: takeWindow,
  publishTrajectoryRuntimeWindowFacts: publishWindow,
} = await import("../../src/trajectory/runtime-window-facts.js");
const sessionId = "synthetic-hot";
const hotIds = Array.from({ length: hotSessions }, (_, index) =>
  index === 0 ? sessionId : `synthetic-hot-${index}`,
);
const target = {
  agentId: "main",
  sessionId,
  sessionKey: `agent:main:${sessionId}`,
  storePath: path.join(root, "agents/main/sessions/sessions.json"),
};
await replaceSessionEntry(target, { sessionId, updatedAt: 1 });
const options = {
  agentId: "main",
  path: path.join(root, "agents/main/agent/openclaw-agent.sqlite"),
};
const database = openOpenClawAgentDatabase(options);
assert(database.db instanceof DatabaseSync);
const native = database.db;
const event = {
  traceSchema: "openclaw-trajectory",
  schemaVersion: 1,
  traceId: sessionId,
  source: "runtime",
  type: "tool.result",
  ts: "2026-10-01T00:00:00.000Z",
  seq: 0,
  sourceSeq: 0,
  sessionId,
  sessionKey: target.sessionKey,
  runId: "synthetic-run",
  data: { payload: "x".repeat(128) },
};
const line = JSON.stringify(event);
const bytes = Buffer.byteLength(line);
const hotRows = Math.floor((10 * 1024 * 1024) / (bytes + 1));
const maxRuntimeBytes = hotRows * (bytes + 1);
const coldRowsPerSession = 30;
const warmup = hotSessions * 10;
const identity = {
  kind: "file" as const,
  physicalIdentity: "synthetic",
  nativeLocation: database.path,
};
const windows = new Map<string, TrajectoryRuntimeWindowFacts>();
let appended = 0;
let measured = false;
let transactionStarted = 0;
const holds: number[] = [];
const sqlTimes: number[] = [];
let iteratorRows = 0;
let iteratorStatements = 0;
// oxlint-disable-next-line typescript/unbound-method -- The probe forwards the native receiver and restores this method.
const nativeExec = DatabaseSync.prototype.exec;
// oxlint-disable-next-line typescript/unbound-method -- The probe forwards the native receiver and restores this method.
const nativeIterate = StatementSync.prototype.iterate;
const inspector = new Session();
let sampling = false;

function summarize(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const total = sorted.reduce((sum, sample) => sum + sample, 0);
  return {
    samples: sorted.length,
    total,
    mean: total / sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1],
    max: sorted.at(-1),
  };
}

try {
  runOpenClawAgentWriteTransaction(
    ({ db }) => {
      const node = db.prepare(
        "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES(?,?,?,1)",
      );
      const window = db.prepare(
        "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,1,1)",
      );
      const insert = db.prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at,event_utf8_bytes) VALUES(?,?,?,?,1,?)",
      );
      for (let index = 1; index < sessions; index++) {
        const id = hotIds[index] ?? `synthetic-cold-${index}`;
        const key = `agent:main:${id}`;
        node.run(key, id, JSON.stringify({ sessionId: id, updatedAt: 1 }));
        window.run(id, key);
        const coldLine =
          index < hotSessions
            ? line
            : JSON.stringify({ ...event, sessionId: id, sessionKey: key, traceId: id });
        const coldBytes = Buffer.byteLength(coldLine);
        for (let seq = 0; seq < (index < hotSessions ? hotRows : coldRowsPerSession); seq++) {
          insert.run(id, seq, `synthetic-run-${seq % 3}`, coldLine, coldBytes);
        }
      }
      for (let seq = 0; seq < hotRows; seq++) {
        insert.run(sessionId, seq, event.runId, line, bytes);
      }
    },
    options,
    { operationLabel: "trajectory.benchmark.seed" },
  );

  const run = () => {
    const selectedId = hotIds[appended++ % hotSessions]!;
    const windowFacts = append(
      {
        sessionId: selectedId,
        maxRuntimeBytes,
        windowFacts: takeWindow(identity, selectedId),
        events: [{ line, ts: event.ts, runId: event.runId }],
      },
      database,
      (operationLabel, write) =>
        runOpenClawAgentWriteTransaction(
          (current) => {
            const started = performance.now();
            const result = write(current);
            if (measured) {
              sqlTimes.push(performance.now() - started);
            }
            return result;
          },
          options,
          { operationLabel },
        ),
    ).receipt.windowFacts;
    publishWindow(identity, selectedId, windowFacts);
    windows.set(selectedId, windowFacts);
  };
  for (let index = 0; index < warmup; index++) {
    run();
  }
  DatabaseSync.prototype.exec = function (sql) {
    const result = nativeExec.call(this, sql);
    if (measured && this === native) {
      if (/^BEGIN IMMEDIATE\b/i.test(sql)) {
        transactionStarted = performance.now();
      }
      if (/^COMMIT\b/i.test(sql)) {
        holds.push(performance.now() - transactionStarted);
      }
    }
    return result;
  };
  if (values.mode === "counts") {
    StatementSync.prototype.iterate = function (...bindings) {
      const iterator: ReturnType<typeof nativeIterate> = Reflect.apply(
        nativeIterate,
        this,
        bindings,
      );
      if (!measured || !this.sourceSQL.includes("trajectory_runtime_events")) {
        return iterator;
      }
      iteratorStatements++;
      const next = iterator.next.bind(iterator);
      iterator.next = (...args) => {
        const item = next(...args);
        if (!item.done) {
          iteratorRows++;
        }
        return item;
      };
      return iterator;
    };
  }
  global.gc();
  await nextTurn();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 8192,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    sampling = true;
  }
  const memoryBefore = process.memoryUsage();
  const hostLoadBefore = loadavg();
  const cpuStart = process.threadCpuUsage();
  const start = performance.now();
  measured = true;
  for (let index = 0; index < iterations; index++) {
    run();
  }
  measured = false;
  const elapsedMs = performance.now() - start;
  const cpu = process.threadCpuUsage(cpuStart);
  const memoryAfter = process.memoryUsage();
  let allocation;
  if (sampling) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampling = false;
    const sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    allocation = {
      sampledBytes,
      bytesPerAppend: sampledBytes / iterations,
      samples: profile.samples.length,
    };
    fs.writeFileSync(path.join(root, "allocation.heapprofile"), JSON.stringify(profile));
  }
  const persisted = hotIds.map((id, index) => {
    const row = native
      .prepare(
        "SELECT COUNT(*) AS count, MIN(seq) AS first, MAX(seq) AS last, SUM(event_utf8_bytes+1) AS bytes FROM trajectory_runtime_events WHERE session_id=?",
      )
      .get(id);
    const writes = Math.floor((warmup + iterations + hotSessions - 1 - index) / hotSessions);
    assert.deepEqual(
      { ...row },
      { count: hotRows, first: writes, last: hotRows + writes - 1, bytes: maxRuntimeBytes },
    );
    assert.deepEqual(windows.get(id), {
      retainedBytes: maxRuntimeBytes,
      nextSeq: hotRows + writes,
    });
    return row;
  });
  const plans = [
    ...["ASC", "DESC"].map(
      (direction) =>
        `SELECT seq, coalesce(event_utf8_bytes,octet_length(event_json)) AS event_bytes, NULL AS event_json FROM trajectory_runtime_events WHERE session_id=? ORDER BY seq ${direction}`,
    ),
    "DELETE FROM trajectory_runtime_events WHERE session_id=? AND seq<=0",
  ].map((sql) => ({ sql, plan: native.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(sessionId) }));
  const ownerRelative = "src/trajectory/runtime-window-facts.ts";
  const owner = path.join(
    process.env.OPENCLAW_BENCH_BASELINE_DIR ?? fileURLToPath(new URL("../../", import.meta.url)),
    ownerRelative,
  );
  const result = {
    variant: values.variant,
    mode: values.mode,
    node: process.version,
    ownerSha256: createHash("sha256").update(fs.readFileSync(owner)).digest("hex"),
    iterations,
    sessions,
    hotSessions,
    seededRows: (sessions - hotSessions) * coldRowsPerSession + hotRows * hotSessions,
    hotRows,
    maxRuntimeBytes,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    cpuUsPerAppend: (cpu.user + cpu.system) / iterations,
    transactionHoldMs: summarize(holds),
    sqlCallbackMs: summarize(sqlTimes),
    allocation,
    iteratorRows: values.mode === "counts" ? iteratorRows : undefined,
    iteratorStatements: values.mode === "counts" ? iteratorStatements : undefined,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    memoryBefore,
    memoryAfter,
    persisted,
    plans,
  };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  measured = false;
  DatabaseSync.prototype.exec = nativeExec;
  StatementSync.prototype.iterate = nativeIterate;
  if (sampling) {
    await inspector.post("HeapProfiler.stopSampling");
  }
  inspector.disconnect();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
