/**
 * Synthetic active-facts owner proof; see transcript-active-facts.md for fixture/VFS setup.
 * node --import ./scripts/tsx.mjs scripts/perf/transcript-active-facts.ts <command> \
 *   --output .local/active-facts --base <predecessor-sha> [--name team]
 * Commands: prepare, upgrade, read (--phase empty|partial|full, optionally
 * --mode allocation --iterations 100), append
 * (--mode timing|allocation --iterations 5000), rollback. Timing append runs four
 * A/A and five AB/BA pairs; allocation runs two separate AB/BA pairs. --skip-controls
 * reuses already recorded controls. --label names a fresh result without overwriting.
 * This measures real SQLite owners, not Gateway transport or physical disk reads.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { sql } from "kysely";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../packages/agent-core/src/harness/session/background-result-placement.js";
import { restoreDoctorMigrationBackup } from "../../src/commands/doctor-migration-backup-restore.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../src/config/sessions/session-accessor.sqlite-active-context.js";
import { hydrateSessionActorState } from "../../src/config/sessions/session-actor-hydration.worker.js";
import { createTranscriptIndexAppenderInTransaction } from "../../src/config/sessions/session-transcript-index.js";
import { transcriptEventReadBytesSql } from "../../src/config/sessions/session-transcript-read-bytes.js";
import {
  createTranscriptEventInserter,
  transcriptEventDependencyNavigationSql,
  transcriptEventModelNavigationSql,
  transcriptPredicateSql,
  transcriptSerializedBytes,
} from "../../src/config/sessions/transcript-payload.js";
import {
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../../src/infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import {
  createScopedMigrationSnapshot,
  inspectScopedMigrationTables,
} from "../../src/infra/sqlite-migration-scoped-snapshot.js";
import { admitSqliteSchema } from "../../src/infra/sqlite-schema-facts.js";
import { configureSqliteWalMaintenance } from "../../src/infra/sqlite-wal.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../src/state/openclaw-agent-db-contract.js";
import {
  readOpenClawAgentDatabaseIdentity,
  registerOpenClawAgentDatabaseIdentity,
} from "../../src/state/openclaw-agent-db-identity.js";
import { withAgentDatabaseMaintenanceLease } from "../../src/state/openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "../../src/state/openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../src/state/openclaw-agent-schema.js";
import { resolveSchemaMigrationBackupTables } from "../../src/state/schema-migration-backup-scope.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string" },
    base: { type: "string" },
    name: { type: "string", default: "team" },
    phase: { type: "string", default: "empty" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string" },
    label: { type: "string", default: "" },
    "skip-controls": { type: "boolean", default: false },
  },
});
assert(values.output && values.base, "--output and --base are required");
assert(/^[a-z0-9-]+$/u.test(values.name) && /^[a-z0-9-]*$/u.test(values.label));
assert(values.phase === "empty" || values.phase === "partial" || values.phase === "full");
assert(values.mode === "timing" || values.mode === "allocation");
const iterations = Number(values.iterations ?? (positionals[0] === "read" ? "100" : "5000"));
assert(Number.isSafeInteger(iterations) && iterations > 0);
const output = path.resolve(values.output);
const repository = fileURLToPath(new URL("../../", import.meta.url));
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(process.platform === "darwin"
        ? { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" }
        : {}),
    },
  });
const baseSha = git("rev-parse", "--verify", `${values.base}^{commit}`).trim();
const baseDirectory = path.join(output, `base-${baseSha}`);
const fixture = path.join(output, `${values.name}.sqlite`);
const suffix = values.label ? `-${values.label}` : "";
const resultName = `${values.name}${suffix}`;
const fixtureSession = "synthetic-0";
const extension = path.join(
  output,
  process.platform === "darwin" ? "bufprobe.dylib" : "bufprobe.so",
);
const result = (name: string, value: unknown) => {
  fs.writeFileSync(path.join(output, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(JSON.stringify(value));
};

// Only these changed owners are frozen; their other dependencies use the tooling checkout.
const frozenFiles = [
  "src/config/sessions/session-accessor.sqlite-active-context.ts",
  "src/config/sessions/session-accessor.sqlite-reset-window.ts",
  "src/config/sessions/session-actor-context-stats.worker.ts",
  "src/config/sessions/session-actor-hydration.worker.ts",
  "src/config/sessions/session-transcript-index.ts",
  "src/config/sessions/transcript-payload.ts",
  "src/state/openclaw-agent-db-schema-read.ts",
  "src/state/openclaw-agent-db-contract.ts",
  "src/state/openclaw-schema-versions.ts",
];
const frozenBySource = new Map(
  frozenFiles.map((relative) => [
    path.join(repository, relative),
    path.join(baseDirectory, path.basename(relative)),
  ]),
);
function writeFrozen(file: string, source: string) {
  if (fs.existsSync(file)) {
    assert.equal(fs.readFileSync(file, "utf8"), source, `Frozen source changed: ${file}`);
  } else {
    fs.writeFileSync(file, source, { flag: "wx" });
  }
}
function prepareBaseline() {
  fs.mkdirSync(baseDirectory, { recursive: true });
  for (const relative of frozenFiles) {
    const origin = path.join(repository, relative);
    const source = git("show", `${baseSha}:${relative}`).replace(
      /((?:from\s+|import\()\s*)["'](\.[^"']+)["']/gu,
      (_match: string, prefix: string, specifier: string) => {
        const absolute = path.resolve(path.dirname(origin), specifier);
        const typedSource = absolute.replace(/\.js$/u, ".ts");
        const destination = frozenBySource.get(typedSource) ?? typedSource;
        return `${prefix}${JSON.stringify(pathToFileURL(destination).href)}`;
      },
    );
    writeFrozen(path.join(baseDirectory, path.basename(relative)), source);
  }
  writeFrozen(
    path.join(baseDirectory, "base-schema.sql"),
    git("show", `${baseSha}:src/state/openclaw-agent-schema.sql`),
  );
}
const frozenModule = (name: string) => pathToFileURL(path.join(baseDirectory, `${name}.ts`)).href;
prepareBaseline();

function loadProbe(db: DatabaseSync) {
  db.loadExtension(extension, "sqlite3_bufprobe_init");
}
function resetProbe(db: DatabaseSync) {
  db.prepare("SELECT buf696_reset()").get();
}
function readProbe(db: DatabaseSync): unknown {
  return JSON.parse(String(db.prepare("SELECT buf696_io() AS io").get()?.io));
}
function restoreProbe(db: DatabaseSync) {
  db.prepare("SELECT buf696_restore()").get();
}
function timing(start: number, cpu: NodeJS.CpuUsage) {
  const delta = process.cpuUsage(cpu);
  return {
    wall_ms: performance.now() - start,
    cpu_ms: (delta.user + delta.system) / 1000,
    load: os.loadavg(),
  };
}
async function upgrade() {
  const env = { ...process.env, OPENCLAW_STATE_DIR: output };
  process.env.OPENCLAW_STATE_DIR = output;
  const phases: unknown[] = [];
  const report: Record<string, unknown> = {
    base: baseSha,
    file_bytes: fs.statSync(fixture).size,
    target: OPENCLAW_AGENT_SCHEMA_VERSION,
    phases,
  };
  using control = new DatabaseSync(":memory:", { allowExtension: true });
  await withAgentDatabaseMaintenanceLease({ env }, async (lease) => {
    // The VFS must not intercept the maintenance owner's worker initialization/retirement.
    loadProbe(control);
    try {
      using source = new DatabaseSync(fixture, { readOnly: true });
      const predecessor = Number(source.prepare("PRAGMA user_version").get()?.user_version);
      const scope = resolveSchemaMigrationBackupTables({
        kind: "agent",
        foundVersion: predecessor,
        supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      assert(scope, "This workload requires an explicit scoped migration");
      report.scope = scope;
      const measure = async (phase: string, invoke: () => unknown) => {
        resetProbe(control);
        const cpu = process.cpuUsage();
        const start = performance.now();
        await invoke();
        phases.push({ phase, ...timing(start, cpu), io: readProbe(control) });
      };
      const backupPath = path.join(output, `${resultName}.scoped.bak`);
      await measure("scoped_backup", () =>
        createScopedMigrationSnapshot({
          sourcePath: fixture,
          targetPath: backupPath,
          tables: scope,
          beforePublish: () => lease.assertOwned(),
        }),
      );
      report.backup_bytes = fs.statSync(backupPath).size;
      report.backup_inspection = inspectScopedMigrationTables(fixture, scope);
      await measure("migration_owner", () => {
        using db = openNodeSqliteDatabase(fixture);
        db.exec("PRAGMA mmap_size=0; PRAGMA cache_size=-2048");
        ensureOpenClawAgentDatabaseSchema(db, {
          agentId: "main",
          path: fixture,
          env,
          register: false,
        });
        report.schema_meta = db.prepare("SELECT schema_version FROM schema_meta").get();
        report.user_version = db.prepare("PRAGMA user_version").get();
        report.facts = db
          .prepare("SELECT count(*) AS count FROM session_transcript_active_event_facts")
          .get();
        report.wal_bytes = fs.existsSync(`${fixture}-wal`) ? fs.statSync(`${fixture}-wal`).size : 0;
      });
    } finally {
      restoreProbe(control);
    }
  });
  result(`${resultName}-migration`, report);
}

function readQueries(database: DatabaseSync) {
  const typed = getNodeSqliteKysely(database);
  const literal = (value: unknown): string => {
    if (typeof value === "string") {
      return `'${value.replaceAll("'", "''")}'`;
    }
    if (typeof value === "number") {
      return String(value);
    }
    throw new Error("Unexpected native expression parameter");
  };
  const expression = (value: ReturnType<typeof sql>) => {
    const compiled = value.compile(typed);
    let index = 0;
    return compiled.sql.replaceAll("?", () => literal(compiled.parameters[index++]));
  };
  const bytes = `${expression(transcriptEventReadBytesSql("event"))} + 1`;
  const type = expression(transcriptPredicateSql(database, "navigation_type", "event"));
  const role = expression(transcriptPredicateSql(database, "message_role", "event"));
  const model = expression(transcriptEventModelNavigationSql(database, "event"));
  const navigation = `CASE WHEN ${type} IN ('custom','reset') OR ${type} IS NULL OR (${type}='message' AND active.context_eligible=0 AND ${role}='assistant') THEN ${model} ELSE '{}' END`;
  const source = "FROM session_transcript_active_events AS active";
  const payload =
    " JOIN transcript_events AS event ON event.session_id=active.session_id AND event.seq=active.event_seq";
  const facts =
    " LEFT JOIN session_transcript_active_event_facts AS facts ON facts.session_id=active.session_id AND facts.seq=active.event_seq";
  const lookup = (field: string) =>
    `(SELECT ${field} FROM transcript_events AS event WHERE event.session_id=active.session_id AND event.seq=active.event_seq)`;
  const coveredBytes = `CASE WHEN facts.seq IS NOT NULL THEN facts.serialized_bytes ELSE ${lookup(bytes)} END`;
  const coveredNavigation = `CASE WHEN facts.seq IS NOT NULL THEN facts.dependency_navigation_json ELSE ${lookup(navigation)} END`;
  const where = `WHERE active.session_id='${fixtureSession}'`;
  const eligible = `${where} AND active.context_eligible=1 ORDER BY active.active_position DESC LIMIT 2001`;
  const candidates = `${where} AND (active.context_eligible=0 OR active.event_seq NOT IN (SELECT seq FROM transcript_event_identities WHERE session_id='${fixtureSession}' AND event_type NOT IN ('custom','reset','branch_summary')))`;
  const filter = `(context_eligible=0 AND json_extract(navigation_json,'$.message.excludeFromContext')=1 AND json_extract(navigation_json,'$.type')='message' AND json_extract(navigation_json,'$.message.role')='assistant' AND json_extract(navigation_json,'$.message.provider')='openclaw' AND json_extract(navigation_json,'$.message.model')='automation-result' AND json_extract(navigation_json,'$.message.openclawModelPlacement')='pending') OR (json_extract(navigation_json,'$.type')='custom' AND json_extract(navigation_json,'$.customType')=${literal(BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE)}) OR json_extract(navigation_json,'$.type') IN ('reset','branch_summary')`;
  const dependency = (join: string, nav: string, size: string, predicate = "") =>
    `WITH dependency AS MATERIALIZED (SELECT active.event_seq,active.active_position,active.context_eligible,${nav} AS navigation_json,${size} AS serialized_bytes ${source}${join} ${candidates}${predicate}) SELECT event_seq,navigation_json,serialized_bytes FROM dependency WHERE ${filter} ORDER BY active_position ASC`;
  return {
    base: {
      metadata: `SELECT active.event_seq,active.active_position,${bytes} AS serialized_bytes ${source}${payload} ${eligible}`,
      dependency: dependency(
        " CROSS JOIN transcript_events AS event",
        navigation,
        bytes,
        " AND event.session_id=active.session_id AND event.seq=active.event_seq",
      ),
    },
    candidate: {
      metadata: `SELECT active.event_seq,active.active_position,${coveredBytes} AS serialized_bytes ${source}${facts} ${eligible}`,
      dependency: dependency(facts, coveredNavigation, coveredBytes),
    },
  };
}

async function read() {
  const baseActor: typeof import("../../src/config/sessions/session-actor-hydration.worker.js") =
    await import(frozenModule("session-actor-hydration.worker"));
  const baseContext: typeof import("../../src/config/sessions/session-accessor.sqlite-active-context.js") =
    await import(frozenModule("session-accessor.sqlite-active-context"));
  using control = new DatabaseSync(":memory:", { allowExtension: true });
  loadProbe(control);
  using db = openNodeSqliteDatabase(fixture, { allowExtension: true });
  loadProbe(db);
  admitSqliteSchema(db);
  enableNodeSqliteKyselyStatementCache(db);
  registerOpenClawAgentDatabaseIdentity(db);
  const walMaintenance = configureSqliteWalMaintenance(db, { databasePath: fixture });
  try {
    const database = { agentId: "main", path: fixture, db, walMaintenance };
    const identity = readOpenClawAgentDatabaseIdentity(database);
    const scope = {
      agentId: "main",
      sessionId: fixtureSession,
      sessionKey: `agent:main:${fixtureSession}`,
      path: fixture,
    };
    const target = {
      sessionKey: scope.sessionKey,
      database: {
        kind: "file" as const,
        physicalIdentity: identity.identity,
        birthtime: identity.birthtime,
        nativeLocation: fixture,
      },
    };
    const queries = readQueries(db);
    db.exec("PRAGMA mmap_size=0; PRAGMA cache_size=-2048");
    db.prepare("DELETE FROM session_transcript_active_event_facts WHERE session_id=?").run(
      fixtureSession,
    );
    if (values.phase !== "empty") {
      const bound =
        values.phase === "partial"
          ? sql`AND active.active_position >= (SELECT max(active_position)-511 FROM session_transcript_active_events WHERE session_id=${fixtureSession})`
          : sql``;
      const populate = sql`INSERT INTO session_transcript_active_event_facts(session_id,seq,serialized_bytes,dependency_navigation_json)
        SELECT active.session_id,active.event_seq,${transcriptEventReadBytesSql("event")}+1,
          ${transcriptEventDependencyNavigationSql(db, sql.ref("active.context_eligible"))}
        FROM session_transcript_active_events AS active JOIN transcript_events AS event
          ON event.session_id=active.session_id AND event.seq=active.event_seq
        WHERE active.session_id=${fixtureSession} ${bound}`;
      const start = performance.now();
      executeSqliteQuerySync(db, { compile: () => populate.compile(getNodeSqliteKysely(db)) });
      console.log(
        JSON.stringify({ fixture_population_ms: performance.now() - start, phase: values.phase }),
      );
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const reports: unknown[] = [];
    const run = (label: string, invoke: () => unknown) => {
      db.exec("PRAGMA shrink_memory; BEGIN IMMEDIATE");
      resetProbe(db);
      const cpu = process.cpuUsage(),
        start = performance.now();
      try {
        const value = invoke();
        reports.push({
          label,
          phase: values.phase,
          ...timing(start, cpu),
          io: readProbe(db),
          ...(typeof value === "number" ? { row_count: value } : {}),
        });
        return value;
      } finally {
        db.exec("ROLLBACK");
      }
    };
    const options = {
      maxEvents: 512,
      maxBytes: 64 * 1024 * 1024,
      ignoreReadFence: true,
      resolvedScope: scope,
      transaction: database,
    };
    const invokeOwner = (owner: "actor" | "context", arm: "base" | "candidate") =>
      owner === "actor"
        ? (arm === "base" ? baseActor.hydrateSessionActorState : hydrateSessionActorState)(
            database,
            target,
            { epoch: "synthetic", sequence: 0 },
            "synthetic",
          )
        : (arm === "base"
            ? baseContext.readSessionTranscriptBoundedActiveContextCore
            : readSessionTranscriptBoundedActiveContextCore)(scope, options);
    if (values.mode === "allocation") {
      const inspector = new Session();
      try {
        for (let pair = 0; pair < 2; pair++) {
          const arms =
            pair % 2 ? (["candidate", "base"] as const) : (["base", "candidate"] as const);
          for (const owner of ["actor", "context"] as const) {
            const outputs = new Map<string, unknown>();
            for (const arm of arms) {
              await startCollectedHeapSampling(inspector, 32768);
              resetProbe(db);
              const cpu = process.cpuUsage(),
                start = performance.now();
              let value: unknown;
              for (let iteration = 0; iteration < iterations; iteration++) {
                db.exec("PRAGMA shrink_memory; BEGIN IMMEDIATE");
                try {
                  value = invokeOwner(owner, arm);
                } finally {
                  db.exec("ROLLBACK");
                }
              }
              const measurement = { ...timing(start, cpu), io: readProbe(db) };
              const { profile } = await inspector.post("HeapProfiler.stopSampling");
              inspector.disconnect();
              reports.push({
                pair,
                owner,
                arm,
                phase: values.phase,
                iterations,
                ...measurement,
                allocation_bytes: sumSampledHeapBytes(profile.head),
              });
              fs.writeFileSync(
                path.join(
                  output,
                  `${resultName}-${values.phase}-${owner}-${pair}-${arm}.heapprofile`,
                ),
                JSON.stringify(profile),
                { flag: "wx" },
              );
              outputs.set(arm, value);
            }
            assert(
              isDeepStrictEqual(outputs.get("base"), outputs.get("candidate")),
              `${owner} outputs differ`,
            );
          }
        }
      } finally {
        inspector.disconnect();
      }
    } else {
      for (let round = 0; round < 5; round++) {
        const actorResults = new Map<string, unknown>();
        const arms =
          round % 2 ? (["candidate", "base"] as const) : (["base", "candidate"] as const);
        for (const arm of arms) {
          for (const query of ["metadata", "dependency"] as const) {
            run(`${arm}-${query}`, () => {
              let count = 0;
              const iterator = db.prepare(queries[arm][query]).iterate();
              try {
                while (!iterator.next().done) {
                  count++;
                  if (query === "metadata" && count === 512) {
                    break;
                  }
                }
              } finally {
                iterator.return?.();
              }
              return count;
            });
          }
          actorResults.set(
            arm,
            run(`actor-${arm}`, () => invokeOwner("actor", arm)),
          );
        }
        assert(
          isDeepStrictEqual(actorResults.get("base"), actorResults.get("candidate")),
          "Base and candidate actor facts differ",
        );
        const contexts = new Map(
          arms.map((arm) => [arm, run(`${arm}-context`, () => invokeOwner("context", arm))]),
        );
        assert(
          isDeepStrictEqual(contexts.get("base"), contexts.get("candidate")),
          "Base and candidate context differ",
        );
      }
    }
    result(`${resultName}-${values.phase}-reads-${values.mode}`, {
      base: baseSha,
      samples: reports,
      native_statement_cache: true,
      context_equal: true,
      actor_equal: true,
      query_plans: Object.fromEntries(
        Object.entries(queries).map(([arm, statements]) => [
          arm,
          Object.fromEntries(
            Object.entries(statements).map(([name, statement]) => [
              name,
              db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(),
            ]),
          ),
        ]),
      ),
    });
  } finally {
    await walMaintenance.stop();
    walMaintenance.close();
    restoreProbe(control);
  }
}

async function append() {
  const basePayload: typeof import("../../src/config/sessions/transcript-payload.js") =
    await import(frozenModule("transcript-payload"));
  const baseIndex: typeof import("../../src/config/sessions/session-transcript-index.js") =
    await import(frozenModule("session-transcript-index"));
  using control = new DatabaseSync(":memory:", { allowExtension: true });
  loadProbe(control);
  let seed = 696;
  const text = (length: number) => {
    let value = "";
    for (let i = 0; i < length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      value += "0123456789abcdef"[seed >>> 28];
    }
    return value;
  };
  const payloads = Array.from({ length: 100 }, (_, i) =>
    text(i < 50 ? 9000 : i < 95 ? 69000 : 410000),
  );
  const inputs = Array.from({ length: iterations }, (_, i) => {
    const sessionId = `synthetic-${i % 4}`,
      seq = Math.floor(i / 4),
      eventId = `event-${seq}`;
    const event = {
      type: "message",
      id: eventId,
      parentId: seq ? `event-${seq - 1}` : null,
      message: { role: "user", content: [{ type: "text", text: payloads[(i * 37) % 100]! }] },
    };
    return { sessionId, seq, eventId, event, eventJson: JSON.stringify(event), createdAt: seq };
  });
  const inspector = values.mode === "allocation" ? new Session() : undefined;
  const records: unknown[] = [];
  async function arm(pair: number, kind: "base" | "candidate", controlPair: boolean) {
    const file = path.join(
      output,
      `${resultName}-append-${values.mode}-${controlPair ? "aa" : "ab"}-${pair}-${kind}.sqlite`,
    );
    fs.closeSync(fs.openSync(file, "wx", 0o600));
    const db = openNodeSqliteDatabase(file, { allowExtension: true });
    try {
      loadProbe(db);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON");
      db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
      admitSqliteSchema(db);
      enableNodeSqliteKyselyStatementCache(db);
      for (let i = 0; i < 4; i++) {
        const id = `synthetic-${i}`;
        db.prepare(
          "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES(?,?,?,1)",
        ).run(id, id, JSON.stringify({ sessionId: id, updatedAt: 1 }));
        db.prepare(
          "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,1,1)",
        ).run(id, id);
      }
      const actual = controlPair ? "base" : kind;
      const inserters = Array.from({ length: 4 }, (_, i) =>
        (actual === "base"
          ? basePayload.createTranscriptEventInserter
          : createTranscriptEventInserter)(db, `synthetic-${i}`),
      );
      const createAppender =
        actual === "base"
          ? baseIndex.createTranscriptIndexAppenderInTransaction
          : createTranscriptIndexAppenderInTransaction;
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const beforeBytes = fs.statSync(file).size;
      if (inspector) {
        await startCollectedHeapSampling(inspector, 32768);
      }
      resetProbe(db);
      const cpu = process.cpuUsage(),
        start = performance.now();
      for (const [index, input] of inputs.entries()) {
        db.exec("BEGIN IMMEDIATE");
        const insert = inserters[index % 4]!;
        const row = {
          seq: input.seq,
          eventJson: input.eventJson,
          createdAt: input.createdAt,
          parsedEvent: input.event,
        };
        const preparedPayload = actual === "candidate" ? insert.prepare(row) : undefined;
        insert({ ...row, preparedPayload });
        const appender = createAppender(db, input.sessionId);
        appender.append({
          seq: input.seq,
          event: input.event,
          eventId: input.eventId,
          createdAt: input.createdAt,
          serializedBytes: transcriptSerializedBytes(db, input.eventJson),
          preparedPayload,
        });
        appender.flush();
        db.exec("COMMIT");
      }
      const measurement = { ...timing(start, cpu), io: readProbe(db) };
      let allocationBytes: number | undefined;
      if (inspector) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        allocationBytes = sumSampledHeapBytes(profile.head);
        inspector.disconnect();
        fs.writeFileSync(
          path.join(output, `${resultName}-append-${pair}-${kind}.heapprofile`),
          JSON.stringify(profile),
          { flag: "wx" },
        );
      }
      const facts = Number(
        db.prepare("SELECT count(*) AS n FROM session_transcript_active_event_facts").get()?.n,
      );
      assert.equal(facts, actual === "candidate" ? iterations : 0);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const record = {
        pair,
        kind,
        actual,
        controlPair,
        mode: values.mode,
        iterations,
        ...measurement,
        allocation_bytes: allocationBytes,
        allocated_file_bytes: fs.statSync(file).size - beforeBytes,
        facts,
      };
      records.push(record);
      fs.appendFileSync(
        path.join(output, `${resultName}-append-${values.mode}.jsonl`),
        `${JSON.stringify(record)}\n`,
      );
      console.log(JSON.stringify(record));
    } finally {
      db.close();
    }
    for (const ending of ["", "-wal", "-shm"]) {
      fs.rmSync(file + ending, { force: true });
    }
  }
  try {
    for (const aa of values.mode === "allocation" || values["skip-controls"]
      ? [false]
      : [true, false]) {
      for (let pair = 0; pair < (values.mode === "allocation" ? 2 : aa ? 4 : 5); pair++) {
        const arms = pair % 2 ? (["candidate", "base"] as const) : (["base", "candidate"] as const);
        for (const kind of arms) {
          await arm(pair, kind, aa);
        }
      }
    }
    result(`${resultName}-append-${values.mode}`, {
      base: baseSha,
      native_statement_cache: true,
      samples: records,
    });
  } finally {
    inspector?.disconnect();
    restoreProbe(control);
  }
}

async function rollback() {
  const older: typeof import("../../src/state/openclaw-agent-db-schema-read.js") = await import(
    frozenModule("openclaw-agent-db-schema-read")
  );
  process.env.OPENCLAW_STATE_DIR = output;
  const payloads = (db: DatabaseSync) =>
    db
      .prepare(
        "SELECT seq,hex(event_zstd) AS payload,event_utf8_bytes,navigation_json FROM transcript_events WHERE session_id='synthetic-0' AND seq IN (0,34152)",
      )
      .all();
  let refusal = "",
    original: string;
  {
    using before = new DatabaseSync(fixture, { readOnly: true });
    try {
      older.assertSupportedAgentSchemaVersion(before, fixture);
    } catch (error) {
      refusal = String(error);
    }
    assert(
      refusal.includes("newer schema version"),
      "Predecessor admission must refuse the upgraded DB",
    );
    original = JSON.stringify(payloads(before));
  }
  const start = performance.now();
  await restoreDoctorMigrationBackup({
    sourcePath: fixture,
    backupPath: path.join(output, `${resultName}.scoped.bak`),
    env: process.env,
  });
  const wall = performance.now() - start;
  using after = new DatabaseSync(fixture, { readOnly: true });
  assert.equal(JSON.stringify(payloads(after)), original);
  const version = older.assertSupportedAgentSchemaVersion(after, fixture);
  assert.equal(
    after
      .prepare(
        "SELECT count(*) AS n FROM sqlite_schema WHERE name='session_transcript_active_event_facts'",
      )
      .get()?.n,
    0,
  );
  result(`${resultName}-rollback`, {
    base: baseSha,
    refusal,
    restoration_wall_ms: wall,
    restored_version: version,
    new_table_absent: true,
    selected_payloads_unchanged: true,
  });
}

const command = positionals[0];
if (command !== "prepare" && command !== "append") {
  assert(
    fs.existsSync(path.join(output, `${values.name}-fixture.json`)),
    "Generate a synthetic fixture first",
  );
}
switch (command) {
  case "prepare":
    console.log(JSON.stringify({ base: baseSha, directory: baseDirectory }));
    break;
  case "upgrade":
    await upgrade();
    break;
  case "read":
    await read();
    break;
  case "append":
    await append();
    break;
  case "rollback":
    await rollback();
    break;
  default:
    throw new Error("Expected prepare, upgrade, read, append, or rollback");
}
process.exit(0);
