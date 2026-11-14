/**
 * Synthetic snapshot hold probe; all state is under .local and removed on exit.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/context-snapshot-holds-measure.ts
 *   --iterations 2000 [--allocations] [--compaction] [--owner /absolute/base.ts]
 * Counterbalance base/candidate processes. Require identical message/store digests,
 * fewer statements, and lower CPU/allocation without retaining payload batches.
 * Diagnostics count native rows/text bytes separately from untraced warm timing.
 * shrink_memory drops SQLite pages only: this is NOT an OS-cold or Gateway claim.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
    compaction: { type: "boolean", default: false },
    owner: { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 2000,
});
const owner = new URL(
  "../../src/config/sessions/session-accessor.sqlite-model-context.ts",
  import.meta.url,
);
let replaced = false;
if (values.owner) {
  const replacement = pathToFileURL(path.resolve(values.owner)).href;
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== owner.href) {
        return nextLoad(url, context);
      }
      replaced = true;
      const loaded = nextLoad(replacement, context);
      return { format: loaded.format, source: loaded.source, shortCircuit: true };
    },
  });
}
const parent = path.resolve(".local");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, "snapshot-holds-"));
Object.assign(process.env, { OPENCLAW_STATE_DIR: root, OPENCLAW_HOME: root });
const env = { ...process.env };
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot({
  logging: { level: "silent", consoleLevel: "silent", file: path.join(root, "run.log") },
});
const agent = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { replaceSessionEntryInDatabase } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-mutation.js");
const { replaceSqliteTranscriptEventsInTransaction } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
const { runWithSqliteWorkerStateContext } =
  await import("../../src/infra/sqlite-worker-state-context.js");
const { clearNodeSqliteKyselyCacheForDatabase } = await import("../../src/infra/kysely-sync.js");
const { isPostgresSqlConnection } = await import("../../src/infra/sql-connection.js");
const { readSessionTranscriptContextMessages, readSessionTranscriptContextSeed } =
  await import("../../src/config/sessions/session-accessor.sqlite-model-context.js");
const { readSessionTranscriptMaintenance } =
  await import("../../src/config/sessions/session-transcript-maintenance-read.js");
assert(!values.owner || replaced, "Baseline override did not load");
const events: unknown[] = Array.from({ length: 1024 }, (_, index) => ({
  type: "message",
  id: `e${index}`,
  parentId: index ? `e${index - 1}` : null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: {
    role: index % 2 ? "toolResult" : "user",
    timestamp: index,
    ...(index % 2 ? { toolCallId: `tool${index}`, toolName: "synthetic", isError: false } : {}),
    content: [{ type: "text", text: `Synthetic ${index} `.padEnd(8192, "x") }],
  },
}));
if (values.compaction) {
  events.push({
    type: "compaction",
    id: "cut",
    timestamp: "2026-01-01T00:00:00.000Z",
    parentId: "e1023",
    firstKeptEntryId: "e480",
    summary: "Earlier synthetic history",
    tokensBefore: 100000,
  });
}
const leaf = values.compaction ? "cut" : "e1023";
const digest = (value: unknown) =>
  hash(
    "sha256",
    JSON.stringify(value, (_key, item: unknown) => (item instanceof Map ? [...item] : item)),
  );
try {
  await runWithSqliteWorkerStateContext({ environment: env }, async () => {
    const options = { agentId: "main", env, path: path.join(root, "agent.sqlite") };
    const database = agent.openOpenClawAgentDatabase(options);
    const scope = {
      ...options,
      storePath: database.path,
      sessionId: "synthetic",
      sessionKey: "agent:main:synthetic",
    };
    agent.runOpenClawAgentWriteTransaction(() => {
      replaceSessionEntryInDatabase(database, scope.sessionKey, {
        sessionId: scope.sessionId,
        updatedAt: 1,
      });
      replaceSqliteTranscriptEventsInTransaction(
        database,
        scope,
        [
          {
            type: "session",
            id: scope.sessionId,
            version: 3,
            timestamp: "2026-01-01T00:00:00.000Z",
            cwd: "/synthetic",
          },
          ...events,
          {
            type: "custom",
            id: "store",
            parentId: leaf,
            customType: "openclaw.code-mode-store",
            data: { set: { key: "kept" }, delete: [], networkContent: { key: false } },
          },
        ],
        { rebuildProjectionSynchronously: true, scheduleProjectionReconcile: false },
      );
    }, options);
    const current = readSessionTranscriptMaintenance(database, scope, {
      operation: "version",
    }).version;
    assert(current?.generation);
    const workloads = {
      context: () => readSessionTranscriptContextMessages(scope, (messages) => [...messages]),
      seed: () =>
        readSessionTranscriptContextSeed(scope, {
          maxBytes: 1024 * 1024,
          tokenBudget: 32000,
          beforeAdmittedUser: false,
        }).messages,
      maintenanceCold: () =>
        readSessionTranscriptMaintenance(database, scope, {
          operation: "code-mode-store",
          leafEntryId: "store",
        }).store,
      maintenanceSuffix: () =>
        readSessionTranscriptMaintenance(database, scope, {
          operation: "code-mode-store",
          leafEntryId: "store",
          checkpoint: { generation: current.generation!, rawSeq: 1000, leafEntryId: "e999" },
        }).store,
    };
    const db = database.db;
    assert(!isPostgresSqlConnection(db));
    for (const [name, read] of Object.entries(workloads)) {
      const expected = digest(read());
      const diagnostics = [];
      for (const cache of ["warm", "sqlite-pages-released"]) {
        if (cache !== "warm") {
          db.exec("PRAGMA shrink_memory");
        }
        clearNodeSqliteKyselyCacheForDatabase(db);
        let rows = 0;
        let textBytes = 0;
        let payloadBytes = 0;
        const observeRow = (row: unknown) => {
          if (!isRecord(row)) {
            return;
          }
          rows++;
          for (const [key, value] of Object.entries(row)) {
            if (typeof value === "string") {
              textBytes += Buffer.byteLength(value);
              if (key === "event_json") {
                payloadBytes += Buffer.byteLength(value);
              }
            }
          }
        };
        const prepare = db.prepare.bind(db);
        db.prepare = (sqlText) => {
          const statement = prepare(sqlText);
          statement.get = new Proxy(statement.get.bind(statement), {
            apply(get, _receiver, args) {
              const row = get(...args);
              observeRow(row);
              return row;
            },
          });
          statement.all = new Proxy(statement.all.bind(statement), {
            apply(all, _receiver, args) {
              const result = all(...args);
              result.forEach(observeRow);
              return result;
            },
          });
          statement.iterate = new Proxy(statement.iterate.bind(statement), {
            apply(iterate, _receiver, args) {
              const result = iterate(...args);
              return (function* () {
                for (const row of result) {
                  observeRow(row);
                  yield row;
                }
                return undefined;
              })();
            },
          });
          return statement;
        };
        const statements = new Map<string, { count: number; sqlMs: number }>();
        let begin: number | undefined;
        let holdMs = 0;
        const observe = (event: unknown) => {
          assert(
            isRecord(event) &&
              typeof event.sql === "string" &&
              typeof event.durationMs === "number",
          );
          if (event.sql === "BEGIN") {
            begin = performance.now();
          }
          if (event.sql === "COMMIT" && begin !== undefined) {
            holdMs += performance.now() - begin;
          }
          const id = hash("sha256", event.sql).slice(0, 16);
          const previous = statements.get(id) ?? { count: 0, sqlMs: 0 };
          previous.count++;
          previous.sqlMs += event.durationMs;
          statements.set(id, previous);
        };
        const channelOwner = channel("openclaw.database.statement");
        channelOwner.subscribe(observe);
        const started = performance.now();
        let actual: unknown;
        try {
          actual = read();
        } finally {
          channelOwner.unsubscribe(observe);
          db.prepare = prepare;
          clearNodeSqliteKyselyCacheForDatabase(db);
        }
        const totalMs = performance.now() - started;
        assert.equal(digest(actual), expected);
        const sqlMs = [...statements.values()].reduce((total, value) => total + value.sqlMs, 0);
        diagnostics.push({
          cache,
          rows,
          textBytes,
          payloadBytes,
          holdMs,
          totalMs,
          sqlMs,
          jsMs: holdMs - sqlMs,
          statements: Object.fromEntries(statements),
        });
      }
      for (let i = 0; i < 10; i++) {
        read();
      }
      globalThis.gc?.();
      await setImmediate();
      const inspector = new Session();
      if (values.allocations) {
        await startCollectedHeapSampling(inspector, 16384);
      }
      const cpu = process.threadCpuUsage();
      const started = performance.now();
      let last: unknown;
      for (let i = 0; i < iterations; i++) {
        last = read();
      }
      const elapsedMs = performance.now() - started;
      const used = process.threadCpuUsage(cpu);
      const allocatedBytes = values.allocations
        ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
      if (values.allocations) {
        inspector.disconnect();
      }
      assert.equal(digest(last), expected);
      console.log(
        JSON.stringify({
          name,
          iterations,
          compaction: values.compaction,
          digest: expected,
          cpuMs: (used.user + used.system) / 1000,
          elapsedMs,
          allocatedBytes,
          memory: process.memoryUsage(),
          hostLoad: loadavg(),
          diagnostics,
        }),
      );
    }
  });
} finally {
  await agent.closeOpenClawAgentDatabasesAsync(root);
  await closeOpenClawStateDatabaseAsync();
  await rm(root, { recursive: true, force: true });
}
