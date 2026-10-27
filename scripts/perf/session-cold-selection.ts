/**
 * Synthetic owner benchmark for cold selection and its commit protection scans.
 * Prepare once (full current agent schema, synthetic metadata and transcript rows):
 *   node --import ./scripts/tsx.mjs scripts/perf/session-cold-selection.ts \
 *     --prepare --state-dir "$PWD/.local/cold-selection-fixture"
 * Then run alternating baseline/candidate processes against the unchanged fixture:
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-cold-selection.ts \
 *     --state-dir "$PWD/.local/cold-selection-fixture" --iterations 20 \
 *     [--owner-module /absolute/frozen-selection.ts] [--eligibility-module /absolute/frozen-eligibility.ts] \
 *     [--protection] [--allocation | --sql | --holds]
 * --mutation [--worker-module /absolute/frozen-worker.ts] prepares one real archive
 * outside measurement and exercises the real cold-batch mutation. An outer owner
 * transaction rolls each successful swap back, keeping each iteration identical.
 * Mutation timing includes rollback, not physical commit/fsync; committed correctness
 * belongs to the focused owner tests. Preparation is the same for both revisions.
 * --holds instruments native exec on the target database only. Each outer transaction
 * starts after a successful BEGIN returns and ends just before successful COMMIT or
 * ROLLBACK execution. Savepoints are ignored. Hold wall/thread CPU exclude BEGIN waits
 * and end execution; endExecMs reports the latter separately. finishMs is performance
 * time immediately after end execution. Exactly one complete hold per operation is
 * required. This diagnostic pass is separate from uninstrumented owner timing.
 * Freeze changed owner modules with their relative imports resolved to absolute source paths.
 * Allocation and SQL instrumentation are separate passes, never timing evidence.
 * Selection includes its production read transaction; protection measures both helpers
 * inside the production snapshot wrapper. SQL row counts are rows delivered to JS,
 * not SQLite scan counts. Query plans identify full scans; use a VM-step probe for
 * internal row visits. Fixture generation and imports are outside measurement.
 * CPU/allocation cover this isolate, not a Gateway or reclamation-worker transport.
 * Cold markers are synthetic metadata: this fixture must never be used for restoration.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    prepare: { type: "boolean" },
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "10000" },
    hot: { type: "string", default: "128" },
    events: { type: "string", default: "1000" },
    "body-bytes": { type: "string", default: "1024" },
    iterations: { type: "string", default: "20" },
    "owner-module": { type: "string" },
    "eligibility-module": { type: "string" },
    "worker-module": { type: "string" },
    mutation: { type: "boolean" },
    protection: { type: "boolean" },
    allocation: { type: "boolean" },
    sql: { type: "boolean" },
    holds: { type: "boolean" },
  },
});
assert(values["state-dir"], "--state-dir is required");
assert(
  [values.allocation, values.sql, values.holds].filter(Boolean).length <= 1,
  "Use separate allocation, SQL, and transaction-hold passes",
);
assert(!(values.mutation && values.protection), "Choose one measured operation");
const root = path.resolve(values["state-dir"]);
const options = { agentId: "main", path: path.join(root, "agent.sqlite") };
const manifestPath = path.join(root, "fixture.json");
const positive = (input: string) => {
  const value = Number(input);
  assert(Number.isSafeInteger(value) && value > 0, "Expected a positive integer");
  return value;
};
type Fixture = { sessions: number; hot: number; events: number; bodyBytes: number };
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = path.join(root, "home");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
process.env.TMPDIR = path.join(root, "tmp");
const agent = await import("../../src/state/openclaw-agent-db.js");
const state = await import("../../src/state/openclaw-state-db.js");
const id = (index: number) => `cold-selection-${String(index).padStart(5, "0")}`;
const restorers: (() => void)[] = [];
try {
  if (values.prepare) {
    mkdirSync(root, { mode: 0o700 });
    for (const directory of ["home", "tmp", "workspace"]) {
      mkdirSync(path.join(root, directory));
    }
    writeFileSync(
      process.env.OPENCLAW_CONFIG_PATH,
      JSON.stringify({
        agents: { entries: { main: { workspace: path.join(root, "workspace") } } },
      }),
    );
    const fixture: Fixture = {
      sessions: positive(values.sessions),
      hot: positive(values.hot),
      events: positive(values.events),
      bodyBytes: positive(values["body-bytes"]),
    };
    assert(fixture.hot <= fixture.sessions);
    agent.runOpenClawAgentWriteTransaction(({ db }) => {
      // sqlite-allow-raw -- Synthetic fixture insertion into the real admitted schema.
      const node = db.prepare(
        "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at,entry_valid) VALUES(?,?,?,1,1)",
      );
      const window = db.prepare(
        "INSERT INTO session_windows(session_id,session_key,created_at,updated_at,transcript_updated_at) VALUES(?,?,1,1,1)",
      );
      const watermark = db.prepare(
        "INSERT INTO transcript_rewrite_watermarks(session_id,generation,updated_at) VALUES(?,?,1)",
      );
      const cold = db.prepare(
        "INSERT INTO session_transcript_cold_archives(session_id,generation,archive_name,archive_sha256,event_count,raw_bytes,archive_bytes,last_seq,archived_at,storage,archive_blob) VALUES(?,?,?,?,1,1,1,0,1,'file',NULL)",
      );
      const event = db.prepare(
        "INSERT INTO transcript_events(session_id,seq,event_json,created_at,event_utf8_bytes) VALUES(?,?,?,1,?)",
      );
      const payload = JSON.stringify({
        type: "message",
        message: { role: "user", content: "x".repeat(fixture.bodyBytes) },
      });
      for (let index = 0; index < fixture.sessions; index++) {
        const sessionId = id(index);
        const key = `agent:main:${sessionId}`;
        node.run(key, sessionId, JSON.stringify({ sessionId, updatedAt: 1 }));
        window.run(sessionId, key);
        watermark.run(sessionId, `generation-${index}`);
        if (index < fixture.sessions - fixture.hot) {
          const hash = index.toString(16).padStart(64, "0");
          cold.run(sessionId, `generation-${index}`, `${hash}.jsonl.zst`, hash);
        } else {
          for (let seq = 0; seq < fixture.events; seq++) {
            event.run(sessionId, seq, payload, Buffer.byteLength(payload));
          }
        }
      }
    }, options);
    writeFileSync(manifestPath, JSON.stringify(fixture));
    console.log(JSON.stringify({ prepared: fixture }));
  } else {
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as Fixture;
    const owner: typeof import("../../src/config/sessions/session-cold-storage-selection.js") =
      await import(
        values["owner-module"]
          ? pathToFileURL(path.resolve(values["owner-module"])).href
          : "../../src/config/sessions/session-cold-storage-selection.js"
      );
    const eligibility: typeof import("../../src/config/sessions/session-cold-storage-eligibility.js") =
      await import(
        values["eligibility-module"]
          ? pathToFileURL(path.resolve(values["eligibility-module"])).href
          : "../../src/config/sessions/session-cold-storage-eligibility.js"
      );
    const { runSqliteReadSnapshotSync } = await import("../../src/infra/sqlite-transaction.js");
    const database = agent.openOpenClawAgentDatabase(options);
    const ids = Array.from({ length: fixture.hot }, (_, index) =>
      id(fixture.sessions - fixture.hot + index),
    );
    const input = {
      databaseOptions: options,
      admissionIdentities: [],
      liveSessionKeys: [],
      cooledSessionIds: [],
      beforeMs: 100,
      maxTranscripts: fixture.hot,
      maxBytes: 64 * 1024 * 1024,
    };
    const worker:
      | typeof import("../../src/config/sessions/session-cold-storage-worker.js")
      | undefined = values.mutation
      ? await import(
          values["worker-module"]
            ? pathToFileURL(path.resolve(values["worker-module"])).href
            : "../../src/config/sessions/session-cold-storage-worker.js"
        )
      : undefined;
    const prepared = values.mutation
      ? await (
          await import("../../src/config/sessions/session-cold-storage-prepare.js")
        ).prepareSessionColdBatchInWorker({ ...input, maxTranscripts: 1 })
      : undefined;
    if (prepared) {
      assert.equal(prepared.prepared.length, 1);
    }
    const rollback = new Error("benchmark rollback");
    const run = () => {
      if (prepared && worker) {
        try {
          agent.runOpenClawAgentWriteTransaction(
            () => {
              const result = worker.mutateSessionColdTranscriptInWorker(
                {
                  kind: "cold-batch",
                  databaseOptions: options,
                  prepared: prepared.prepared,
                  externalizations: [],
                  beforeMs: input.beforeMs,
                  protectionKeys: prepared.protectionKeys,
                  liveSessionKeys: [],
                },
                undefined,
                () => {},
              );
              assert.equal(result.archivedTranscripts, 1);
              throw rollback;
            },
            options,
            { operationLabel: "cold selection benchmark rollback" },
          );
        } catch (error) {
          if (error !== rollback) {
            throw error;
          }
        }
      } else if (values.protection) {
        runSqliteReadSnapshotSync(
          database.db,
          () => {
            assert.equal(owner.readSessionAdmissionProtectionKeys(database, ids).size, fixture.hot);
            assert.equal(
              eligibility.readSessionColdStorageProtection(database, 100, new Set(), ids).size,
              0,
            );
          },
          { operationLabel: "cold selection benchmark protection" },
        );
      } else {
        const result = owner.selectSessionColdBatch(input);
        assert(result.found);
        assert.equal(result.value.plans.length, fixture.hot);
      }
    };
    const statements = new Map<
      string,
      { calls: number; rows: number; ms: number; expanded: string }
    >();
    const holds: {
      begin: string;
      end: string;
      wallMs: number;
      threadCpuMs: number;
      endExecMs: number;
      finishMs: number;
    }[] = [];
    const activeHolds = new Map<
      DatabaseSync,
      { begin: string; wall: number; cpu: NodeJS.CpuUsage }
    >();
    if (values.holds) {
      // oxlint-disable-next-line typescript/unbound-method -- Forward the native receiver via call and restore the method after measurement.
      const original = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function (this: DatabaseSync, statement: string) {
        const begins =
          /^\s*BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?\s*;?\s*$/iu.test(
            statement,
          );
        const ends = /^\s*(?:COMMIT|END|ROLLBACK)(?:\s+TRANSACTION)?\s*;?\s*$/iu.test(statement);
        const active = ends ? activeHolds.get(this) : undefined;
        const endingWall = active ? performance.now() : 0;
        const endingCpu = active ? process.threadCpuUsage(active.cpu) : undefined;
        const starts = begins && !this.isTransaction && this.location() === options.path;
        const endExecStart = active ? performance.now() : 0;
        original.call(this, statement);
        if (starts) {
          activeHolds.set(this, {
            begin: statement,
            wall: performance.now(),
            cpu: process.threadCpuUsage(),
          });
        } else if (active && endingCpu) {
          const finishMs = performance.now();
          holds.push({
            begin: active.begin,
            end: statement,
            wallMs: endingWall - active.wall,
            threadCpuMs: (endingCpu.user + endingCpu.system) / 1000,
            endExecMs: finishMs - endExecStart,
            finishMs,
          });
          activeHolds.delete(this);
        }
      };
      restorers.push(() => {
        DatabaseSync.prototype.exec = original;
      });
    }
    if (values.sql) {
      for (const method of ["all", "get", "iterate"] as const) {
        const original = StatementSync.prototype[method];
        const replacement = function (this: StatementSync, ...args: unknown[]) {
          const start = performance.now();
          const result: unknown = Reflect.apply(original, this, args);
          const entry = statements.get(this.sourceSQL) ?? {
            calls: 0,
            rows: 0,
            ms: 0,
            expanded: this.expandedSQL,
          };
          statements.set(this.sourceSQL, entry);
          entry.calls++;
          if (method === "iterate") {
            return (function* () {
              try {
                for (const row of result as Iterable<unknown>) {
                  entry.rows++;
                  yield row;
                }
              } finally {
                entry.ms += performance.now() - start;
              }
            })();
          }
          entry.rows += Array.isArray(result) ? result.length : result === undefined ? 0 : 1;
          entry.ms += performance.now() - start;
          return result;
        };
        Object.defineProperty(StatementSync.prototype, method, {
          value: replacement,
          configurable: true,
          writable: true,
        });
        restorers.push(() =>
          Object.defineProperty(StatementSync.prototype, method, {
            value: original,
            configurable: true,
            writable: true,
          }),
        );
      }
    }
    for (let warm = 0; warm < 3; warm++) {
      run();
    }
    statements.clear();
    holds.length = 0;
    assert.equal(activeHolds.size, 0, "Warmup left an unfinished transaction");
    globalThis.gc?.();
    const inspector = new Session();
    if (values.allocation) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const iterations = values.sql ? 1 : positive(values.iterations);
    const before = process.memoryUsage();
    const hostLoad = loadavg();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    const operationMs: number[] = [];
    for (let index = 0; index < iterations; index++) {
      const operationStart = performance.now();
      run();
      operationMs.push(performance.now() - operationStart);
    }
    const wallMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    const after = process.memoryUsage();
    let sampledAllocationBytes: number | undefined;
    if (values.allocation) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      sampledAllocationBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
      inspector.disconnect();
    }
    while (restorers.length) {
      restorers.pop()?.();
    }
    if (values.holds) {
      assert.equal(activeHolds.size, 0, "Measurement left an unfinished transaction");
      assert.equal(
        holds.length,
        iterations,
        "Expected one complete target transaction per operation",
      );
    }
    const sql = values.sql
      ? [...statements].map(([query, stats]) => {
          let plan: unknown;
          try {
            plan = database.db.prepare(`EXPLAIN QUERY PLAN ${stats.expanded}`).all();
          } catch {
            plan = "not explainable";
          }
          return { query, calls: stats.calls, rows: stats.rows, ms: stats.ms, plan };
        })
      : undefined;
    console.log(
      JSON.stringify(
        {
          fixture,
          mode: values.mutation
            ? "mutation-rollback"
            : values.protection
              ? "protection"
              : "selection",
          iterations,
          instrumented: values.allocation
            ? "allocation"
            : values.sql
              ? "sql"
              : values.holds
                ? "holds"
                : false,
          wallMs,
          operationMs,
          threadCpuMs: (used.user + used.system) / 1000,
          sampledAllocationBytes,
          before,
          after,
          hostLoad,
          sql,
          holds: values.holds ? holds : undefined,
        },
        null,
        2,
      ),
    );
  }
} finally {
  while (restorers.length) {
    restorers.pop()?.();
  }
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
}
