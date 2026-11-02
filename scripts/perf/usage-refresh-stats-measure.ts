/**
 * Synthetic transcript statistics owner proof; no Gateway or physical-I/O claim.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/usage-refresh-stats-measure.ts
 *   --root .local/2090/fixture --prepare --sessions 5000 --events 280 --body-kib 32
 * Repeat without --prepare, with --mode timing|allocation|sql and --label A1.
 * --revision pins only the statistics owner to a Git revision; shared dependencies
 * stay current. Run five counterbalanced A/A and A/B pairs in separate processes.
 * SQL mode replays captured native expanded SQL with SQLite CLI .stats, mmap off,
 * 2MiB private page cache. Page misses × 4096 are logical pager reads, not disk I/O.
 * Acceptance: identical statistics; eliminate unchanged-prefix event reads, lower
 * CPU/time beyond A/A spread; report allocation and any >20% regression separately.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { UsageCostSqliteCheckpoint } from "../../src/infra/session-cost-usage-rollup-codec.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    prepare: { type: "boolean" },
    sessions: { type: "string", default: "5000" },
    events: { type: "string", default: "280" },
    "body-kib": { type: "string", default: "32" },
    samples: { type: "string", default: "5" },
    mode: { type: "string", default: "timing" },
    label: { type: "string", default: "candidate" },
    revision: { type: "string" },
    selected: { type: "string", default: "5000" },
    scenario: { type: "string", default: "stats" },
  },
});
assert(values.root, "--root must name a synthetic fixture directory");
assert(["timing", "allocation", "sql"].includes(values.mode));
assert(["stats", "unchanged", "dirty"].includes(values.scenario));
const positive = (value: string) => {
  const number = Number(value);
  assert(Number.isSafeInteger(number) && number > 0);
  return number;
};
const sessions = positive(values.sessions);
const events = positive(values.events);
const bodyBytes = positive(values["body-kib"]) * 1024;
const root = path.resolve(values.root);
const manifestPath = path.join(root, "usage-refresh-stats-fixture.json");
const ownerPath =
  values.scenario === "stats"
    ? "src/config/sessions/session-accessor.sqlite-transcript-stats.ts"
    : "src/infra/session-cost-usage-refresh-inputs.worker.ts";
const ownerUrl = pathToFileURL(path.resolve(ownerPath)).href;
const source = values.revision
  ? (() => {
      const result = spawnSync("git", ["show", `${values.revision}:${ownerPath}`], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    })()
  : readFileSync(ownerPath, "utf8");
if (values.revision) {
  registerHooks({
    load(url, context, nextLoad) {
      return url === ownerUrl
        ? { source, format: "module-typescript", shortCircuit: true }
        : nextLoad(url, context);
    },
  });
}
const sourceSha256 = createHash("sha256").update(source).digest("hex");
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = path.join(root, "home");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.js");
const { admitSqliteSchema } = await import("../../src/infra/sqlite-schema-facts.js");
const { prepareTranscriptPayload } =
  await import("../../src/config/sessions/transcript-payload.js");
const { readTranscriptStatsBatchFromDatabase } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-stats.js");
const { createUsageCostCollectionAccess } =
  await import("../../src/infra/session-cost-usage-refresh-inputs.worker.js");
const { OpenClawAgentDatabaseReadOnlyScope } =
  await import("../../src/state/openclaw-agent-db-readonly-scope.js");
const { withOpenClawAgentDatabaseReadOnly } =
  await import("../../src/state/openclaw-agent-db-readonly.js");

const sessionId = (index: number) => `synthetic-usage-${String(index).padStart(5, "0")}`;
if (values.prepare) {
  assert(!existsSync(root), "Refusing to replace an existing fixture directory");
  mkdirSync(root, { recursive: true });
  const opened = openOpenClawAgentDatabase({ agentId: "main", env: process.env });
  const db = opened.db;
  const now = 1_793_528_460_000;
  const node = db.prepare(
    "INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid,updated_at) VALUES(?,?,?,1,?)",
  );
  const window = db.prepare(
    "INSERT INTO session_windows(session_id,session_key,created_at,updated_at,transcript_updated_at,transcript_observed_at) VALUES(?,?,?,?,?,?)",
  );
  db.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < sessions; index++) {
    const id = sessionId(index);
    const key = `agent:main:${id}`;
    node.run(key, id, JSON.stringify({ sessionId: id, updatedAt: now }), now);
    window.run(id, key, now, now, now, now);
  }
  db.exec("COMMIT");
  const insert = db.prepare(`INSERT INTO transcript_events(
    session_id,seq,event_json,created_at,event_zstd,event_utf8_bytes,navigation_json,
    navigation_type,navigation_custom_type,navigation_display,message_role,
    navigation_last_type,navigation_last_custom_type,navigation_valid
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const cipher = createCipheriv(
    "aes-256-ctr",
    createHash("sha256").update("synthetic-usage-refresh-stats-v1").digest(),
    Buffer.alloc(16),
  );
  let totalUtf8Bytes = 0;
  let compressedRows = 0;
  const started = performance.now();
  for (let seq = 1; seq <= events; seq++) {
    const text = cipher
      .update(Buffer.alloc(Math.ceil((bodyBytes * 3) / 4)))
      .toString("base64")
      .slice(0, bodyBytes);
    const event = {
      type: "message",
      id: `event-${seq}`,
      parentId: seq > 1 ? `event-${seq - 1}` : null,
      timestamp: new Date(now).toISOString(),
      message: {
        role: seq % 2 ? "user" : "assistant",
        content: [{ type: "text", text }],
        ...(seq % 2 ? {} : { usage: { input: 100, output: 25, cost: { total: 0.001 } } }),
      },
    };
    const json = JSON.stringify(event);
    const payload = prepareTranscriptPayload(db, json, event);
    assert(payload.event_zstd, "Random base64 should still produce a compressed UTF-8 payload");
    totalUtf8Bytes += Buffer.byteLength(json) * sessions;
    // Interleaved sessions scatter each session's B-tree payload access across the file.
    for (let offset = 0; offset < sessions; offset += 250) {
      db.exec("BEGIN IMMEDIATE");
      for (let index = offset; index < Math.min(sessions, offset + 250); index++) {
        const compressed = index % 2 === 1;
        insert.run(
          sessionId(index),
          seq,
          compressed ? null : json,
          now,
          compressed ? payload.event_zstd : null,
          Buffer.byteLength(json),
          payload.navigation_json,
          payload.navigation_type,
          payload.navigation_custom_type,
          payload.navigation_display,
          payload.message_role,
          payload.navigation_last_type,
          payload.navigation_last_custom_type,
          payload.navigation_valid,
        );
        compressedRows += Number(compressed);
      }
      db.exec("COMMIT");
    }
    if (seq % 20 === 0) {
      console.error(
        JSON.stringify({ preparedEvents: seq * sessions, elapsedMs: performance.now() - started }),
      );
    }
  }
  cipher.final();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const manifest = {
    format: "openclaw-usage-refresh-stats-v1",
    databasePath: opened.path,
    sessions,
    eventsPerSession: events,
    bodyBytes,
    now,
    totalUtf8Bytes,
    compressedRows,
    databaseBytes: statSync(opened.path).size,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await closeOpenClawAgentDatabasesAsync();
  console.log(JSON.stringify({ prepared: manifest }));
} else {
  const fixture: {
    format: string;
    databasePath: string;
    sessions: number;
    eventsPerSession: number;
    databaseBytes: number;
    now: number;
    totalUtf8Bytes: number;
  } = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(fixture.format, "openclaw-usage-refresh-stats-v1");
  const selected = Math.min(positive(values.selected), fixture.sessions);
  const ids = Array.from({ length: selected }, (_, index) => sessionId(index));
  const samples = positive(values.samples);
  const summaries = [];
  for (let sample = 0; sample < samples; sample++) {
    using db = openNodeSqliteDatabase(fixture.databasePath, { readOnly: true });
    db.exec("PRAGMA cache_size=-2048; PRAGMA mmap_size=0");
    admitSqliteSchema(db);
    const database = { agentId: "main", path: fixture.databasePath };
    const scope = new OpenClawAgentDatabaseReadOnlyScope();
    if (values.scenario !== "stats") {
      scope.run(database, () => {
        const opened = withOpenClawAgentDatabaseReadOnly(
          (handle) => handle.db.exec("PRAGMA cache_size=-2048; PRAGMA mmap_size=0"),
          { ...database, env: process.env },
        );
        assert(opened.found);
      });
    }
    const statements: string[] = [];
    // Capture only in the separate pager pass; timing/allocation have no wrappers.
    // oxlint-disable-next-line typescript/unbound-method -- Proxy preserves the native database receiver.
    const originalPrepare = DatabaseSync.prototype.prepare;
    if (values.mode === "sql") {
      DatabaseSync.prototype.prepare = new Proxy(originalPrepare, {
        apply(prepare, receiver, args) {
          const statement: StatementSync = Reflect.apply(prepare, receiver, args);
          statement.all = new Proxy(statement.all.bind(statement), {
            apply(all, target, bindings) {
              const rows = Reflect.apply(all, target, bindings);
              if (
                /\b(?:transcript_events|session_windows)\b/.test(statement.sourceSQL) &&
                !/sqlite_schema|sqlite_master/.test(statement.sourceSQL)
              ) {
                statements.push(statement.expandedSQL);
              }
              return rows;
            },
          });
          return statement;
        },
      });
    }
    const checkpoint: UsageCostSqliteCheckpoint = {
      kind: "sqlite",
      maxSeq: fixture.eventsPerSession,
      eventCount: fixture.eventsPerSession,
      size: fixture.totalUtf8Bytes / fixture.sessions + fixture.eventsPerSession - 1,
      mtimeMs: fixture.now - Number(values.scenario === "dirty"),
      anchorHash: "synthetic",
    };
    const collection = createUsageCostCollectionAccess({
      input: {
        kind: "usage-cost",
        databases: [database],
        location: {
          agentId: "main",
          databasePath: fixture.databasePath,
          storePath: fixture.databasePath,
          env: process.env,
        },
        stores: [{ agentId: "main", storePath: fixture.databasePath, database }],
        archiveStorePaths: [fixture.databasePath],
        operation: { kind: "refresh", pricingFingerprint: "synthetic" },
      },
      control: { runNativeSection: async (read) => read(), throwIfCancelled() {} },
      target: () => database,
      readStore: async (_agentId, _storePath, read) => scope.run(database, read),
      readCheckpoint: () => checkpoint,
    });
    const markers = ids.map((id) => ({
      agentId: "main",
      sessionId: id,
      storePath: fixture.databasePath,
    }));
    global.gc?.();
    const inspector = new Session();
    if (values.mode === "allocation") {
      await startCollectedHeapSampling(inspector, 4096);
    }
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    const result =
      values.scenario === "stats"
        ? readTranscriptStatsBatchFromDatabase({ db }, ids, { includeGeneration: true })
        : await collection.access.readSqliteStats(markers);
    const elapsedMs = performance.now() - started;
    const used = process.threadCpuUsage(cpu);
    let allocatedBytes: number | undefined;
    if (values.mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      allocatedBytes = sumSampledHeapBytes(profile.head);
      inspector.disconnect();
    }
    assert.equal(result.length, selected);
    assert(result.every((row) => row?.eventCount === fixture.eventsPerSession));
    assert(result.every((row) => row?.sizeBytes === checkpoint.size));
    DatabaseSync.prototype.prepare = originalPrepare;
    scope.close();
    let pager: { pageMisses: number; logicalBytes: number; plans: string } | undefined;
    if (values.mode === "sql") {
      assert(statements.length > 0);
      const sql = statements.map((statement) => `${statement};`).join("\n");
      writeFileSync(path.join(root, `${values.label}-${sample}.sql`), sql);
      const replay = spawnSync("sqlite3", ["-readonly", fixture.databasePath], {
        input: `PRAGMA mmap_size=0; PRAGMA cache_size=-2048;\n.stats on\n${sql}\n`,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      assert.equal(replay.status, 0, replay.stderr);
      const pageMisses = [...replay.stdout.matchAll(/Page cache misses:\s+(\d+)/g)].reduce(
        (sum, match) => sum + Number(match[1]),
        0,
      );
      const plans = spawnSync("sqlite3", ["-readonly", fixture.databasePath], {
        input: statements.map((statement) => `EXPLAIN QUERY PLAN ${statement};`).join("\n"),
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      assert.equal(plans.status, 0, plans.stderr);
      pager = { pageMisses, logicalBytes: pageMisses * 4096, plans: plans.stdout };
    }
    summaries.push({
      sample,
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      allocatedBytes,
      digest: createHash("sha256")
        .update(
          JSON.stringify(
            result.map((row) => ({
              eventCount: row?.eventCount,
              maxSeq: row?.maxSeq,
              sizeBytes: row?.sizeBytes,
              lastMutationAtMs: row?.lastMutationAtMs,
              generation: row?.generation,
              cold: row?.cold,
            })),
          ),
        )
        .digest("hex"),
      pager,
    });
  }
  console.log(
    JSON.stringify({
      label: values.label,
      mode: values.mode,
      scenario: values.scenario,
      sourceSha256,
      revision: values.revision ?? "working-tree",
      fixture,
      selected,
      hostLoad: loadavg(),
      node: process.version,
      samples: summaries,
    }),
  );
}
