/**
 * Synthetic background-result-heavy hydration owner probe; never use a live root.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-hydration-statement-measure.ts \
 *   --root .local/cron-hydration --prepare
 * Repeat without --prepare for timing, or --allocation / --profile for separate passes.
 * Use --no-observe for production wall/CPU/allocation. Diagnostic-channel native
 * timing is a separate pass: its SQL normalization adds work outside statements.
 * The same database has 5,000 sessions and 1k/10k/50k histories (one result and
 * placement per four rows), an unplaced result before compaction, and a short tail.
 * Ordinary and excluded-user histories are negative controls at the same sizes.
 * --revision pins attribution owners; --owner-revision or --owner-source pins the query.
 * --proof asserts slow metadata and real forced-GC scope separation.
 * --body-kib 32 prepares multi-GB overflow rows; --selected 2,5,8 selects 50k histories.
 * --sql separately records native page misses using a task-owned diagnostic extension (requires cc).
 * Operation totals are exact; iterator statement deltas include any nested consumer reads.
 * --cold evicts only this Linux fixture and records kernel physical readBytes.
 * Acceptance: preserve returned bytes and pending results; improve expensive owner
 * CPU/time beyond A/A spread, and disclose every >20% timing/allocation regression.
 * Five interleaved A/A pairs measure fixed-window owner scaling, native statement
 * wall time, thread CPU, and sampled JS allocation (not native SQLite allocation).
 * This is an admitted synchronous owner snapshot, not complete Gateway latency.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readThreadDiskReadBytes } from "../../src/infra/thread-disk-io.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { evictLinuxFilePageCache } from "../lib/linux-page-cache.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    prepare: { type: "boolean" },
    "body-kib": { type: "string", default: "0" },
    selected: { type: "string" },
    sql: { type: "boolean" },
    cold: { type: "boolean" },
    allocation: { type: "boolean" },
    profile: { type: "boolean" },
    revision: { type: "string" },
    pairs: { type: "string", default: "5" },
    proof: { type: "boolean" },
    label: { type: "string", default: "candidate" },
    "owner-revision": { type: "string" },
    "owner-source": { type: "string" },
    "no-observe": { type: "boolean", default: false },
  },
});
assert(values.root);
assert(!values.cold || process.platform === "linux", "--cold requires Linux");
const bodyBytes = Number(values["body-kib"]) * 1024;
assert(Number.isSafeInteger(bodyBytes) && bodyBytes >= 0);
const root = path.resolve(values.root);
const manifestPath = path.join(root, "cron-hydration-fixture.json");
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
});
if (values.revision || values["owner-revision"] || values["owner-source"]) {
  const sources = new Map<string, string>();
  const selected = [
    ...[
      "src/infra/sqlite-transaction.ts",
      "src/infra/database-engine/observation.ts",
      "src/state/openclaw-agent-db-readonly-open.ts",
    ].map((file) => ({ file, revision: values.revision })),
    {
      file: "src/config/sessions/session-accessor.sqlite-active-context.ts",
      revision: values["owner-revision"],
    },
  ];
  for (const { file, revision } of selected) {
    if (revision) {
      sources.set(
        pathToFileURL(path.resolve(file)).href,
        execFileSync("git", ["show", `${revision}:${file}`], { encoding: "utf8" }),
      );
    }
  }
  if (values["owner-source"]) {
    sources.set(
      pathToFileURL(path.resolve("src/config/sessions/session-accessor.sqlite-active-context.ts"))
        .href,
      readFileSync(values["owner-source"], "utf8"),
    );
  }
  registerHooks({
    load(url, context, next) {
      const source = sources.get(url);
      return source === undefined
        ? next(url, context)
        : { source, format: "module-typescript", shortCircuit: true };
    },
  });
}
const { isPostgresSqlConnection } = await import("../../src/infra/sql-connection.js");
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { prepareTranscriptPayload } =
  await import("../../src/config/sessions/transcript-payload.js");
const { openOpenClawAgentDatabaseReadOnly } =
  await import("../../src/state/openclaw-agent-db-readonly.js");
const { runSqliteReadSnapshotSync } = await import("../../src/infra/sqlite-transaction.js");
const { readSessionTranscriptBoundedActiveContextCore } =
  await import("../../src/config/sessions/session-accessor.sqlite-active-context.js");
const histories = [1_000, 10_000, 50_000, 1_000, 10_000, 50_000, 1_000, 10_000, 50_000];
const selected = values.selected
  ? values.selected.split(",").map(Number)
  : histories.map((_, index) => index);
assert(
  selected.every((index) => Number.isInteger(index) && index >= 0 && index < histories.length),
);
const sessionId = (index: number) => `synthetic-cron-${index}`;
const now = 1_793_528_460_000;
if (values.prepare) {
  assert(!existsSync(root), "Refusing to replace an existing fixture");
  mkdirSync(root, { recursive: true });
  const database = openOpenClawAgentDatabase({ agentId: "main", env: process.env });
  const db = database.db;
  const node = db.prepare(
    "INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid,updated_at) VALUES(?,?,?,1,?)",
  );
  const window = db.prepare(
    "INSERT INTO session_windows(session_id,session_key,created_at,updated_at,transcript_updated_at,transcript_observed_at) VALUES(?,?,?,?,?,?)",
  );
  const event = db.prepare(
    `INSERT INTO transcript_events(session_id,seq,event_json,created_at,event_zstd,event_utf8_bytes,navigation_json,navigation_type,navigation_custom_type,navigation_display,message_role,navigation_last_type,navigation_last_custom_type,navigation_valid) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const identity = db.prepare(
    "INSERT INTO transcript_event_identities(session_id,event_id,seq,event_type,parent_id,created_at) VALUES(?,?,?,?,?,?)",
  );
  const active = db.prepare(
    "INSERT INTO session_transcript_active_events(session_id,active_position,event_seq,message_position,context_eligible) VALUES(?,?,?,?,?)",
  );
  const projection = db.prepare(
    "INSERT INTO session_transcript_index_state(session_id,indexed_seq,leaf_event_id,needs_rebuild,active_event_count,active_message_count,updated_at) VALUES(?,?,?,0,?,?,?)",
  );
  const cipher = createCipheriv(
    "aes-256-ctr",
    createHash("sha256").update("synthetic-cron-overflow-v1").digest(),
    Buffer.alloc(16),
  );
  const body = () =>
    bodyBytes
      ? cipher
          .update(Buffer.alloc(Math.ceil((bodyBytes * 3) / 4)))
          .toString("base64")
          .slice(0, bodyBytes)
      : "Synthetic body ".repeat(64);
  db.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < 5_000; index++) {
    const id = sessionId(index),
      key = `agent:main:${id}`;
    node.run(key, id, JSON.stringify({ sessionId: id, updatedAt: now }), now);
    window.run(id, key, now, now, now, now);
    const count = histories[index] ?? 2;
    let messageCount = 0;
    for (let seq = 0; seq <= count + 12; seq++) {
      const pending =
        index < 3 && seq > 0 && (seq === count + 1 || (seq <= count && seq % 4 === 1));
      const placement = index < 3 && seq > 0 && seq <= count && seq % 4 === 2;
      const compaction = seq === count + 2;
      const entry =
        seq === 0
          ? { type: "session", id, version: 3, timestamp: new Date(now).toISOString() }
          : {
              id: `event-${seq}`,
              parentId: seq > 1 ? `event-${seq - 1}` : null,
              timestamp: new Date(now).toISOString(),
              ...(placement
                ? {
                    type: "custom",
                    customType: "openclaw.background-result-placement",
                    data: {
                      afterEntryId: `event-${seq - 2}`,
                      resultEntryIds: [`event-${seq - 1}`],
                    },
                  }
                : compaction
                  ? {
                      type: "compaction",
                      summary: "Synthetic earlier cron history",
                      firstKeptEntryId: `event-${index >= 6 && index < 9 ? count + 1 : count - 1}`,
                      tokensBefore: 100_000,
                    }
                  : {
                      type: "message",
                      message: {
                        role: pending ? "assistant" : "user",
                        ...(index >= 6 && index < 9 && seq <= count
                          ? { excludeFromContext: true }
                          : {}),
                        content: [{ type: "text", text: body() }],
                        ...(pending
                          ? {
                              provider: "openclaw",
                              model: "automation-result",
                              excludeFromContext: true,
                              openclawModelPlacement: "pending",
                            }
                          : {}),
                      },
                    }),
            };
      const payload = prepareTranscriptPayload(db, JSON.stringify(entry), entry);
      event.run(
        id,
        seq,
        payload.event_json,
        now,
        payload.event_zstd,
        payload.event_utf8_bytes,
        payload.navigation_json,
        payload.navigation_type,
        payload.navigation_custom_type,
        payload.navigation_display,
        payload.message_role,
        payload.navigation_last_type,
        payload.navigation_last_custom_type,
        payload.navigation_valid,
      );
      identity.run(id, entry.id, seq, entry.type, "parentId" in entry ? entry.parentId : null, now);
      if (seq > 0) {
        active.run(
          id,
          seq - 1,
          seq,
          entry.type === "message" ? messageCount++ : null,
          pending || (index >= 6 && index < 9 && seq <= count) ? 0 : 1,
        );
      }
    }
    projection.run(id, count + 12, `event-${count + 12}`, count + 12, messageCount, now);
  }
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  writeFileSync(
    manifestPath,
    JSON.stringify({ databasePath: database.path, histories, sessions: 5_000, bodyBytes }),
  );
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  console.log(JSON.stringify({ prepared: true, databaseBytes: statSync(database.path).size }));
  process.exit(0);
}
const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as { databasePath: string };
assert(path.resolve(fixture.databasePath).startsWith(root + path.sep));
const opened = openOpenClawAgentDatabaseReadOnly(
  { agentId: "main", path: fixture.databasePath },
  { allowExtension: values.sql },
);
assert(opened.found);
const db = opened.database.db;
assert(!isPostgresSqlConnection(db));
const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size);
assert(Number.isSafeInteger(pageSize) && pageSize > 0);
const tempStore = db.prepare("PRAGMA temp_store").get()?.temp_store;
const tempStoreCompile = db
  .prepare("PRAGMA compile_options")
  .all()
  .map((row) => row.compile_options)
  .find((value) => typeof value === "string" && value.startsWith("TEMP_STORE="));
const captured: Array<{ sql: string; logicalBytes: number }> = [];
let capturing = false;
let pagerMisses: (() => number) | undefined;
if (values.sql) {
  const extensionSource = path.join(root, "pager-diagnostic.c");
  const extensionPath = path.join(root, "pager-diagnostic.so");
  writeFileSync(
    extensionSource,
    `#include <sqlite3ext.h>
static const sqlite3_api_routines *functions;
static void misses(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  int current = 0, highwater = 0;
  int result = functions->db_status(functions->context_db_handle(ctx), SQLITE_DBSTATUS_CACHE_MISS, &current, &highwater, 0);
  if (result != SQLITE_OK) functions->result_error(ctx, "pager status unavailable", -1);
  else functions->result_int(ctx, current);
}
int sqlite3_extension_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
  functions = api;
  return functions->create_function(db, "openclaw_pager_misses", 0, SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, misses, 0, 0);
}
`,
  );
  execFileSync("cc", ["-shared", "-fPIC", extensionSource, "-o", extensionPath]);
  db.loadExtension(extensionPath);
  const counter = db.prepare("SELECT openclaw_pager_misses() AS misses");
  const misses = () => Number(counter.get()!.misses);
  pagerMisses = misses;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    for (const method of ["get", "all"] as const) {
      const execute = statement[method].bind(statement);
      Object.defineProperty(statement, method, {
        configurable: true,
        writable: true,
        value: new Proxy(execute, {
          apply(read, target, parameters) {
            const before = misses();
            const result = Reflect.apply(read, target, parameters);
            if (capturing) {
              captured.push({
                sql: statement.expandedSQL,
                logicalBytes: (misses() - before) * pageSize,
              });
            }
            return result;
          },
        }),
      });
    }
    statement.iterate = new Proxy(statement.iterate.bind(statement), {
      apply(iterate, target, parameters) {
        const iterator: ReturnType<typeof statement.iterate> = Reflect.apply(
          iterate,
          target,
          parameters,
        );
        return (function* () {
          const before = misses();
          try {
            yield* iterator;
          } finally {
            if (capturing) {
              captured.push({
                sql: statement.expandedSQL,
                logicalBytes: (misses() - before) * pageSize,
              });
            }
          }
          return undefined;
        })();
      },
    });
    return statement;
  };
}
const inspector = new Session();
const warnings: Record<string, unknown>[] = [];
const read = (index: number) => {
  const target = {
    agentId: "main",
    sessionId: sessionId(index),
    sessionKey: `agent:main:${sessionId(index)}`,
    storePath: fixture.databasePath,
    path: fixture.databasePath,
  };
  return runSqliteReadSnapshotSync(
    db,
    () =>
      readSessionTranscriptBoundedActiveContextCore(target, {
        maxEvents: 50,
        maxBytes: 1_024_000,
        transaction: { agentId: "main", path: fixture.databasePath, db },
        resolvedScope: target,
      }),
    {
      operationLabel: "sessions.transcript-hydration.cron-model",
      ...(values.proof
        ? {
            slowTransactionHoldMs: 0,
            logger: {
              warn(_message: string, metadata?: Record<string, unknown>) {
                if (metadata) {
                  warnings.push(metadata);
                }
              },
            },
          }
        : {}),
    },
  );
};
if (values.proof) {
  read(0);
  const hydration = warnings.at(-1)!;
  const timing = hydration.statementTiming;
  assert(
    timing && typeof timing === "object" && "count" in timing && Number(timing.count) > 0,
    "hydration must report executed native statements",
  );
  const samples: Record<string, unknown>[] = [];
  const options = {
    operationLabel: "sessions.transcript-hydration.cron-model",
    slowTransactionHoldMs: 0,
    logger: {
      warn(_message: string, metadata?: Record<string, unknown>) {
        if (metadata) {
          samples.push(metadata);
        }
      },
    },
  };
  assert(global.gc, "--proof requires --expose-gc");
  runSqliteReadSnapshotSync(
    db,
    () => {
      db.prepare("SELECT 1").get();
      global.gc!();
    },
    options,
  );
  runSqliteReadSnapshotSync(db, () => db.prepare("SELECT 1").get(), options);
  const phases = samples.map((sample) => sample.phases as { callbackGcMs?: number });
  assert((phases[0]!.callbackGcMs ?? 0) > 0, "forced GC must be attributed");
  assert.equal(phases[1]!.callbackGcMs, 0, "next callback must exclude previous GC");
  console.log(JSON.stringify({ hydration, forcedGc: samples[0], next: samples[1] }));
  opened.database.close();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  process.exit(0);
}
for (const index of selected) {
  read(index);
}
if (values.profile) {
  inspector.connect();
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.start");
}
for (let pair = 0; pair < Number(values.pairs); pair++) {
  for (const arm of pair % 2 ? ["A2", "A1"] : ["A1", "A2"]) {
    for (const index of selected) {
      const timings: { sql?: string; durationMs: number }[] = [];
      const subscriber = (message: unknown) => timings.push(message as (typeof timings)[number]);
      if (!values["no-observe"]) {
        channel("openclaw.database.statement").subscribe(subscriber);
      }
      global.gc?.();
      if (values.cold || values.sql) {
        db.exec("PRAGMA mmap_size=0; PRAGMA cache_size=-2048; PRAGMA shrink_memory");
        if (values.cold) {
          evictLinuxFilePageCache(fixture.databasePath);
        }
      }
      if (values.allocation) {
        await startCollectedHeapSampling(inspector, 16_384);
      }
      captured.length = 0;
      capturing = values.sql === true;
      const diskBefore = readThreadDiskReadBytes();
      const pagerBefore = pagerMisses?.();
      const rssBeforeBytes = process.memoryUsage().rss;
      const cpu = process.threadCpuUsage(),
        start = performance.now();
      const result = read(index);
      const elapsedMs = performance.now() - start,
        used = process.threadCpuUsage(cpu);
      const diskAfter = readThreadDiskReadBytes();
      const pagerAfter = pagerMisses?.();
      capturing = false;
      if (!values["no-observe"]) {
        channel("openclaw.database.statement").unsubscribe(subscriber);
      }
      const allocatedBytes = values.allocation
        ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
      if (values.allocation) {
        inspector.disconnect();
      }
      const pager = values.sql
        ? {
            logicalBytes: (pagerAfter! - pagerBefore!) * pageSize,
            statements: captured.map(({ sql, logicalBytes }) => ({
              id: createHash("sha256").update(sql).digest("hex").slice(0, 16),
              inclusiveLogicalBytes: logicalBytes,
              plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(),
            })),
          }
        : undefined;
      if (values.sql) {
        assert(captured.length > 0);
        writeFileSync(
          path.join(root, `hydration-${index}-${values.label}-${pair}-${arm}.sql`),
          captured.map(({ sql }) => `${sql};`).join("\n"),
        );
      }
      assert(
        index >= 3 ||
          result.events.some(
            (entry) => (entry as { id?: string }).id === `event-${histories[index]! + 1}`,
          ),
        "Pending result before compaction must survive",
      );
      assert(result.events.length < 100, "Ordinary payload transfer must remain bounded");
      console.log(
        JSON.stringify({
          revision: values.revision ?? "candidate",
          label: values.label,
          pair,
          arm,
          history: histories[index],
          shape: index < 3 ? "background" : index < 6 ? "ordinary" : "excluded",
          entries: result.events.length,
          elapsedMs,
          cold: values.cold === true,
          databaseBytes: statSync(fixture.databasePath).size,
          readBytes:
            diskBefore === undefined || diskAfter === undefined
              ? undefined
              : diskAfter - diskBefore,
          pager,
          cpuMs: (used.user + used.system) / 1000,
          allocatedBytes,
          rssBeforeBytes,
          rssAfterBytes: process.memoryUsage().rss,
          maxRssKiB: process.resourceUsage().maxRSS,
          tempStore,
          tempStoreCompile,
          observed: !values["no-observe"],
          nativeMs: values["no-observe"]
            ? undefined
            : timings.reduce((sum, row) => sum + row.durationMs, 0),
          statementCount: values["no-observe"] ? undefined : timings.length,
          dependencyMs: values["no-observe"]
            ? undefined
            : timings
                .filter(
                  (row) => row.sql?.includes('"navigation_json"') && row.sql.includes("not in"),
                )
                .reduce((sum, row) => sum + row.durationMs, 0),
          dependencySqlChars: values["no-observe"]
            ? undefined
            : Math.max(
                0,
                ...timings
                  .filter(
                    (row) => row.sql?.includes('"navigation_json"') && row.sql.includes("not in"),
                  )
                  .map((row) => row.sql!.length),
              ),
          payloadMs: values["no-observe"]
            ? undefined
            : timings
                .filter((row) => row.sql?.startsWith('select "seq", "event_json", "event_zstd"'))
                .reduce((sum, row) => sum + row.durationMs, 0),
          digest: createHash("sha256").update(JSON.stringify(result.events)).digest("hex"),
          loadavg: loadavg(),
        }),
      );
    }
  }
}
if (values.profile) {
  writeFileSync(
    path.join(root, "hydration.cpuprofile"),
    JSON.stringify((await inspector.post("Profiler.stop")).profile),
  );
  inspector.disconnect();
}
opened.database.close();
await closeOpenClawAgentDatabasesAsync();
await closeOpenClawStateDatabaseAsync();
