/**
 * Synthetic growing agent DB through the published periodic WAL worker owner.
 * --prepare --root PATH seeds a new fixture (refuses existing directories).
 * Defaults: 5500 sessions x 1000 ~6 KiB events, 980000 cache rows (>30 GiB).
 * Repeat with --root PATH [--revision BASE] [--label LABEL] for A/A and AB pairs.
 * Acceptance: missing/stale statistics refresh off the main thread; old query
 * plans become selective; report first/steady writer hold, CPU, IO, and heap deltas.
 * Use --mode allocation or --mode profile in separate passes. --ioHelper accepts
 * the compiled scripts/perf/backup-verify-rusage.c for macOS physical-read bytes.
 * Heap deltas are retained-memory observations; sampledBytes measures allocation.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    prepare: { type: "boolean" },
    sessions: { type: "string", default: "5500" },
    events: { type: "string", default: "1000" },
    payload: { type: "string", default: "6000" },
    revision: { type: "string" },
    mode: { type: "string", default: "timing" },
    ioHelper: { type: "string" },
    label: { type: "string", default: "candidate" },
    samples: { type: "string", default: "5" },
  },
});
assert(values.root);
assert(["timing", "allocation", "profile"].includes(values.mode));
const root = path.resolve(values.root);
const sessions = Number(values.sessions),
  events = Number(values.events),
  payload = Number(values.payload);
assert([sessions, events, payload].every((n) => Number.isSafeInteger(n) && n > 0));
const manifest = path.join(root, "synthetic-planner.json");
if (values.prepare) {
  mkdirSync(root);
  writeFileSync(manifest, JSON.stringify({ sessions, events, payload }));
}
assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")), { sessions, events, payload });
const measuredLog = path.join(root, `${values.label}.jsonl`);
writeFileSync(measuredLog, "");
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_LOG_FILE: path.join(root, "gateway.log"),
  PLANNER_MEASURE_LOG: measuredLog,
  PLANNER_MEASURE_MODE: values.mode,
  NODE_OPTIONS: [
    process.env.NODE_OPTIONS,
    `--require=${JSON.stringify(path.resolve("scripts/lib/agent-planner-statistics-observer.cjs"))}`,
  ]
    .filter(Boolean)
    .join(" "),
});
if (values.revision) {
  const file = path.join(root, "measured-owner.ts");
  writeFileSync(
    file,
    execFileSync("git", [
      "show",
      `${values.revision}:src/state/openclaw-agent-execution.worker.ts`,
    ]),
  );
  process.env.PLANNER_MEASURE_SOURCE = file;
}
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db.js");
const { observeSqliteWalPeriodicWork } =
  await import("../../src/infra/sqlite-wal-scheduler.test-support.js");
const { selectTranscriptAppendParentIdentity } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-state.queries.js");
const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.js");
const { USAGE_COST_PARTITION_SCOPE, usageCostPartitionKey } =
  await import("../../src/infra/session-cost-usage-partitions.js");
const { USAGE_COST_QUARTER_SCOPE } = await import("../../src/infra/session-cost-usage-quarters.js");
setRuntimeConfigSnapshot({});
openOpenClawStateDatabase();
const scheduled = observeSqliteWalPeriodicWork();
const database = openOpenClawAgentDatabase({ agentId: "planner" });
scheduled.restore();
const db = database.db;
const sid = (n: number) => `session-${String(n).padStart(6, "0")}`;
try {
  if (values.prepare) {
    const node = db.prepare(
      "INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid,updated_at) VALUES(?,?,?,1,1)",
    );
    const window = db.prepare(
      "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,1,1)",
    );
    const event =
      db.prepare(`WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<?)
      INSERT INTO transcript_events(session_id,seq,event_json,created_at) SELECT ?,n,?,1 FROM rows`);
    const identities =
      db.prepare(`INSERT INTO transcript_event_identities(session_id,event_id,seq,event_type,created_at)
      SELECT session_id,'event-'||seq,seq,'message',1 FROM transcript_events WHERE session_id=?`);
    const body = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(payload) }] },
    });
    for (let n = 0; n < sessions; n++) {
      db.exec("BEGIN");
      const id = sid(n),
        key = `agent:planner:${id}`;
      node.run(key, id, JSON.stringify({ sessionId: id, updatedAt: 1 }));
      window.run(id, key);
      event.run(events, id, body);
      identities.run(id);
      if (n === 0) {
        db.exec("PRAGMA analysis_limit=1000; ANALYZE transcript_event_identities");
      }
      db.exec("COMMIT");
      if (n % 64 === 0) {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        console.log(JSON.stringify({ seededSessions: n + 1, bytes: statSync(database.path).size }));
      }
    }
    const cache = db.prepare(
      "INSERT INTO cache_entries(scope,key,value_json,updated_at) VALUES(?,?,?,1)",
    );
    for (let n = 0; n < 20000; n++) {
      db.exec("BEGIN");
      const id = sid(n);
      cache.run("synthetic-rollup", id, "{}");
      for (let month = 1; month <= 24; month++) {
        const date = `${2024 + Math.floor((month - 1) / 12)}-${String(((month - 1) % 12) + 1).padStart(2, "0")}-01`;
        for (const scope of [USAGE_COST_PARTITION_SCOPE, USAGE_COST_QUARTER_SCOPE]) {
          cache.run(
            scope,
            usageCostPartitionKey(id, date),
            JSON.stringify({ padding: "x".repeat(512) }),
          );
        }
      }
      if (n === 0) {
        db.exec("ANALYZE cache_entries");
      }
      db.exec("COMMIT");
      if (n % 1000 === 0) {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writeFileSync(
      path.join(root, "small-statistics.json"),
      JSON.stringify(db.prepare("SELECT * FROM sqlite_stat1").all()),
    );
    console.log(JSON.stringify({ prepared: true, bytes: statSync(database.path).size }));
  } else {
    db.exec("DELETE FROM sqlite_stat1");
    const insert = db.prepare("INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES(?,?,?)");
    for (const row of JSON.parse(readFileSync(path.join(root, "small-statistics.json"), "utf8"))) {
      insert.run(row.tbl, row.idx, row.stat);
    }
    db.exec("ANALYZE sqlite_schema; PRAGMA wal_checkpoint(TRUNCATE)");
    const parent = selectTranscriptAppendParentIdentity(database, sid(0))
      .clearWhere()
      .where("ti.session_id", "=", sid(0))
      .orderBy("ti.seq", "desc")
      .compile();
    const scopes = [USAGE_COST_PARTITION_SCOPE, USAGE_COST_QUARTER_SCOPE];
    const ranges = Array.from({ length: 25 }, (_, n) => [
      ...scopes,
      usageCostPartitionKey(sid(n * 7), ""),
      usageCostPartitionKey(sid(n * 7), "\uffff"),
    ]);
    const deletion = `DELETE FROM cache_entries WHERE ${ranges.map(() => "(scope IN (?,?) AND key>=? AND key<=?)").join(" OR ")}`;
    const plans = (connection = db) => ({
      parent: connection
        .prepare(`EXPLAIN QUERY PLAN ${parent.sql}`)
        .all(...(parent.parameters as string[])),
      deletion: connection.prepare(`EXPLAIN QUERY PLAN ${deletion}`).all(...ranges.flat()),
    });
    const queryCosts = (connection: typeof db) => {
      const append = connection.prepare(parent.sql);
      const remove = connection.prepare(deletion);
      return Array.from({ length: 5 }, () => {
        const cpu = process.threadCpuUsage();
        const started = performance.now();
        append.get(...(parent.parameters as string[]));
        const appendMs = performance.now() - started;
        connection.exec("BEGIN IMMEDIATE");
        const deleteStarted = performance.now();
        try {
          remove.run(...ranges.flat());
          const deleteMs = performance.now() - deleteStarted;
          const used = process.threadCpuUsage(cpu);
          return { appendMs, deleteMs, cpuMs: (used.user + used.system) / 1000 };
        } finally {
          connection.exec("ROLLBACK");
        }
      });
    };
    const io = () =>
      values.ioHelper
        ? (JSON.parse(execFileSync(values.ioHelper, [String(process.pid)], { encoding: "utf8" }))
            .diskReadBytes as number)
        : undefined;
    console.log(
      JSON.stringify({
        label: values.label,
        bytes: statSync(database.path).size,
        load: loadavg(),
        before: plans(),
        beforeQueryCosts: queryCosts(db),
      }),
    );
    for (let i = 0; i < Number(values.samples); i++) {
      const ioBefore = io();
      const walBefore = statSync(`${database.path}-wal`, { throwIfNoEntry: false })?.size ?? 0;
      const start = performance.now();
      await scheduled.periodic();
      const ownerWallMs = performance.now() - start;
      const ioAfter = io();
      console.log(
        JSON.stringify({
          sample: i,
          ownerWallMs,
          walBefore,
          walAfter: statSync(`${database.path}-wal`, { throwIfNoEntry: false })?.size ?? 0,
          diskReadBytes:
            ioAfter !== undefined && ioBefore !== undefined ? ioAfter - ioBefore : undefined,
        }),
      );
    }
    using fresh = openNodeSqliteDatabase(database.path);
    console.log(
      JSON.stringify({
        retained: plans(),
        after: plans(fresh),
        afterQueryCosts: queryCosts(fresh),
        statistics: db
          .prepare(
            "SELECT * FROM sqlite_stat1 WHERE tbl IN ('transcript_events','transcript_event_identities','cache_entries')",
          )
          .all(),
      }),
    );
  }
} finally {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
