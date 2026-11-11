/**
 * Retained cold-navigation storage and page-owner measurement; synthetic state only.
 * Prepare sequentially through the real cold archive producer and commit owner:
 *   node --import ./scripts/tsx.mjs scripts/perf/session-cold-navigation.ts \
 *     --action prepare --state-dir "$PWD/.local/cold-navigation" --sessions 2048 --events 1024
 *   node --import ./scripts/tsx.mjs scripts/perf/session-cold-navigation.ts \
 *     --action storage --state-dir "$PWD/.local/cold-navigation"
 * Storage compares ALL dbstat table/index pages before/after the old archival deletion
 * policy inside a rolled-back transaction. This is an exact retained-row policy delta,
 * not an old-build file-size measurement. Allocated files do not shrink on DELETE.
 * Archive bytes and all non-navigation state remain identical. Payload text is deliberately
 * repetitive synthetic user/assistant/tool history; costs are not a production estimate.
 *
 * Use a smaller separately prepared corpus for owner measurements, alternating >=5 runs:
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-cold-navigation.ts \
 *     --action measure --state-dir "$PWD/.local/cold-navigation-owner" \
 *     --arm retained --iterations 2000 [--allocation]
 * Repeat with --arm restore. Both arms use the current restoration owner; the restore
 * arm includes harmless navigation-delete checks absent from the old owner.
 * Each arm prepares its required stored representation outside measurement. Restore uses
 * the real verification/restoration owner then the SAME bounded page reader, rolling each
 * restoration back to repeat identical work. Its CPU includes rollback but no durable
 * commit/fsync or worker transport; retained reads use normal read snapshots. Both return
 * identical payloads, generation and display cursors. This is an owner comparison, not a
 * substitute for the subscription or built-Gateway workload. Allocation runs are separate
 * from timing, include collected objects, and cover this executing isolate only.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import type { DB } from "../../src/state/openclaw-agent-db.generated.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    action: { type: "string", default: "storage" },
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "2048" },
    events: { type: "string", default: "1024" },
    iterations: { type: "string", default: "2000" },
    arm: { type: "string", default: "retained" },
    allocation: { type: "boolean" },
  },
});
assert(values["state-dir"], "--state-dir is required");
const root = path.resolve(values["state-dir"]);
const manifestPath = path.join(root, "fixture.json");
const options = { agentId: "synthetic", path: path.join(root, "agent.sqlite") };
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = path.join(root, "home");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
process.env.TMPDIR = path.join(root, "tmp");
const agent = await import("../../src/state/openclaw-agent-db.js");
const state = await import("../../src/state/openclaw-state-db.js");
const { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } =
  await import("../../src/infra/kysely-sync.js");
const { readSessionColdTranscript } =
  await import("../../src/config/sessions/session-cold-storage-state.js");
const { createTranscriptEventInserter, prepareTranscriptPayloadForReuse } =
  await import("../../src/config/sessions/transcript-payload.js");
const { prepareSessionColdBatchInWorker } =
  await import("../../src/config/sessions/session-cold-storage-prepare.js");
const owner = await import("../../src/config/sessions/session-cold-storage-worker.js");
const { createSessionTranscriptFtsInserter } =
  await import("../../src/config/sessions/session-transcript-fts.js");
const numberOption = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, fallback: 1, min: 1 });
const sessionId = (index: number) => `cold-navigation-${String(index).padStart(5, "0")}`;
type Fixture = {
  format: "synthetic-cold-navigation-v1";
  sessions: number;
  events: number;
  payloadBytesPerSession: number;
};
function readFixture(): Fixture {
  const fixture: Fixture = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(
    fixture.format,
    "synthetic-cold-navigation-v1",
    "Refusing state not created by this script",
  );
  return fixture;
}
const rollback = new Error("synthetic measurement rollback");

async function prepare() {
  mkdirSync(root, { mode: 0o700 });
  for (const directory of ["home", "tmp", "workspace"]) {
    mkdirSync(path.join(root, directory));
  }
  writeFileSync(
    process.env.OPENCLAW_CONFIG_PATH!,
    JSON.stringify({
      agents: {
        entries: {
          synthetic: { workspace: path.join(root, "workspace") },
        },
      },
    }),
  );
  const sessions = numberOption(values.sessions, "sessions");
  const count = numberOption(values.events, "events");
  const database = agent.openOpenClawAgentDatabase(options);
  const rows = Array.from({ length: count }, (_, seq) => {
    const text = `Synthetic result ${seq}. ${"Read file line: café 雪 🦞. ".repeat(seq % 4 === 2 ? 128 : 32)}`;
    const message =
      seq % 4 === 1
        ? {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: `call-${seq}`,
                name: "read",
                arguments: { path: `synthetic-${seq}.txt` },
              },
            ],
          }
        : seq % 4 === 2
          ? {
              role: "toolResult",
              toolCallId: `call-${seq - 1}`,
              toolName: "read",
              content: [{ type: "text", text }],
            }
          : { role: seq % 4 === 0 ? "user" : "assistant", content: [{ type: "text", text }] };
    const eventJson = JSON.stringify({
      type: "message",
      id: `event-${seq}`,
      parentId: seq ? `event-${seq - 1}` : null,
      message,
    });
    return {
      seq,
      eventJson,
      createdAt: 1,
      preparedPayload: prepareTranscriptPayloadForReuse(database.db, eventJson),
      search: {
        messageId: `event-${seq}`,
        text: seq % 4 === 1 ? `Read synthetic-${seq}.txt` : text,
        role: message.role,
        timestamp: 1,
      },
    };
  });
  const fixture: Fixture = {
    format: "synthetic-cold-navigation-v1",
    sessions,
    events: count,
    payloadBytesPerSession: rows.reduce((sum, row) => sum + Buffer.byteLength(row.eventJson), 0),
  };
  for (let index = 0; index < sessions; index++) {
    const id = sessionId(index);
    agent.runOpenClawAgentWriteTransaction(({ db }) => {
      const query = getNodeSqliteKysely<DB>(db);
      const key = `agent:synthetic:${id}`;
      executeSqliteQuerySync(
        db,
        query.insertInto("session_nodes").values({
          session_key: key,
          current_session_id: id,
          entry_json: JSON.stringify({ sessionId: id, updatedAt: 1 }),
          entry_valid: 1,
          updated_at: 1,
        }),
      );
      executeSqliteQuerySync(
        db,
        query.insertInto("session_windows").values({
          session_id: id,
          session_key: key,
          created_at: 1,
          updated_at: 1,
          transcript_updated_at: 1,
        }),
      );
      executeSqliteQuerySync(
        db,
        query
          .insertInto("transcript_rewrite_watermarks")
          .values({ session_id: id, generation: `generation-${index}`, updated_at: 1 }),
      );
      createTranscriptEventInserter(db, id).batch(rows);
      createSessionTranscriptFtsInserter(db, id)(rows.map((row) => row.search));
      for (let offset = 0; offset < count; offset += 256) {
        const selected = rows.slice(offset, offset + 256);
        executeSqliteQuerySync(
          db,
          query.insertInto("transcript_event_identities").values(
            selected.map(({ seq }) => ({
              session_id: id,
              event_id: `event-${seq}`,
              seq,
              event_type: "message",
              parent_id: seq ? `event-${seq - 1}` : null,
              message_idempotency_key: null,
              created_at: 1,
            })),
          ),
        );
        executeSqliteQuerySync(
          db,
          query.insertInto("session_transcript_active_events").values(
            selected.map(({ seq }) => ({
              session_id: id,
              active_position: seq,
              event_seq: seq,
              message_position: seq,
              context_eligible: 1,
            })),
          ),
        );
      }
      executeSqliteQuerySync(
        db,
        query.insertInto("session_transcript_index_state").values({
          session_id: id,
          indexed_seq: count - 1,
          leaf_event_id: `event-${count - 1}`,
          needs_rebuild: 0,
          active_event_count: count,
          active_message_count: count,
          updated_at: 1,
        }),
      );
    }, options);
    // Archive immediately, bounding the amount of hot payload state on disk.
    const prepared = await prepareSessionColdBatchInWorker({
      databaseOptions: options,
      admissionIdentities: [],
      liveSessionKeys: [],
      cooledSessionIds: [],
      beforeMs: 100,
      maxTranscripts: 1,
      maxBytes: 64 * 1024 * 1024,
    });
    assert.equal(prepared.prepared.length, 1);
    const result = owner.mutateSessionColdTranscriptInWorker(
      {
        kind: "cold-batch",
        databaseOptions: options,
        prepared: prepared.prepared,
        externalizations: [],
        beforeMs: 100,
        protectionKeys: prepared.protectionKeys,
        liveSessionKeys: [],
      },
      undefined,
      () => {},
    );
    assert.equal(result.archivedTranscripts, 1);
    if ((index + 1) % 128 === 0) {
      process.stderr.write(`Archived ${index + 1}/${sessions} synthetic sessions\n`);
    }
  }
  writeFileSync(manifestPath, JSON.stringify(fixture));
  return { prepared: fixture };
}

function removeNavigation() {
  agent.runOpenClawAgentWriteTransaction(({ db }) => {
    const query = getNodeSqliteKysely<DB>(db);
    const ids = query.selectFrom("session_transcript_cold_archives").select("session_id");
    executeSqliteQuerySync(
      db,
      query.deleteFrom("transcript_events").where("session_id", "in", ids),
    );
    executeSqliteQuerySync(
      db,
      query.deleteFrom("session_transcript_index_state").where("session_id", "in", ids),
    );
  }, options);
}

function footprint() {
  const database = agent.openOpenClawAgentDatabase(options);
  const query = getNodeSqliteKysely<
    DB & {
      dbstat: { name: string; pgsize: number; payload: number; unused: number };
      sqlite_schema: { name: string; tbl_name: string };
      pragma_page_size: { page_size: number };
      pragma_page_count: { page_count: number };
      pragma_freelist_count: { freelist_count: number };
    }
  >(database.db);
  const tables = executeSqliteQuerySync(
    database.db,
    query
      .selectFrom("dbstat as pages")
      .leftJoin("sqlite_schema as catalog", "catalog.name", "pages.name")
      .select(["pages.name", "catalog.tbl_name"])
      .select(({ fn }) => [
        fn.sum<number>("pages.pgsize").as("bytes"),
        fn.sum<number>("pages.payload").as("payloadBytes"),
        fn.sum<number>("pages.unused").as("unusedBytes"),
      ])
      .groupBy(["pages.name", "catalog.tbl_name"])
      .orderBy("pages.name"),
  ).rows;
  const pageSize = executeSqliteQueryTakeFirstSync(
    database.db,
    query.selectFrom("pragma_page_size").selectAll(),
  )!.page_size;
  const pageCount = executeSqliteQueryTakeFirstSync(
    database.db,
    query.selectFrom("pragma_page_count").selectAll(),
  )!.page_count;
  const freePages = executeSqliteQueryTakeFirstSync(
    database.db,
    query.selectFrom("pragma_freelist_count").selectAll(),
  )!.freelist_count;
  const archives = executeSqliteQueryTakeFirstSync(
    database.db,
    query
      .selectFrom("session_transcript_cold_archives")
      .select(({ fn }) => [
        fn.countAll<number>().as("sessions"),
        fn.sum<number>("archive_bytes").as("archiveBytes"),
        fn.sum<number>("raw_bytes").as("rawBytes"),
      ]),
  )!;
  const files = [options.path, `${options.path}-wal`].map((file) => {
    try {
      const stat = statSync(file);
      return { name: path.basename(file), bytes: stat.size, allocatedBytes: stat.blocks * 512 };
    } catch {
      return { name: path.basename(file), bytes: 0, allocatedBytes: 0 };
    }
  });
  return {
    ...archives,
    pageSize,
    pageCount,
    freePages,
    livePageBytes: tables.reduce((sum, row) => sum + row.bytes, 0),
    tables,
    files,
  };
}

function storage() {
  const fixture = readFixture();
  const candidate = footprint();
  let previous: ReturnType<typeof footprint> | undefined;
  try {
    agent.runOpenClawAgentWriteTransaction(() => {
      removeNavigation();
      previous = footprint();
      throw rollback;
    }, options);
  } catch (error) {
    if (error !== rollback) {
      throw error;
    }
  }
  assert(previous);
  assert.equal(previous.archiveBytes, candidate.archiveBytes);
  assert.equal(candidate.sessions, fixture.sessions);
  const addedBytes = candidate.livePageBytes - previous.livePageBytes;
  return {
    scope: "real candidate archives; rollback-only old deletion-policy counterfactual",
    candidate,
    previous,
    addedLivePageBytes: addedBytes,
    addedBytesPerArchivedSession: addedBytes / candidate.sessions,
  };
}

async function measure() {
  assert(globalThis.gc, "Run with --expose-gc");
  assert(values.arm === "retained" || values.arm === "restore");
  const fixture = readFixture();
  const iterations = numberOption(values.iterations, "iterations");
  const database = agent.openOpenClawAgentDatabase(options);
  const { backfillSessionColdNavigationInTransaction } =
    await import("../../src/config/sessions/session-cold-storage-navigation.js");
  const { readCurrentProjectionSnapshot } =
    await import("../../src/config/sessions/session-accessor.sqlite-projection-read.js");
  const { createSessionColdPayloadReader } =
    await import("../../src/config/sessions/session-cold-storage-payload-read.js");
  const { readSessionTranscriptHistoryEventPageFromProjection } =
    await import("../../src/config/sessions/session-accessor.sqlite-history-query.js");
  const { resolveWorkerVisibleHistoryProjection } =
    await import("../../src/config/sessions/session-accessor.sqlite-history-projection.worker.js");
  if (values.arm === "restore") {
    removeNavigation();
  } else {
    for (let index = 0; index < fixture.sessions; index++) {
      const id = sessionId(index);
      const query = getNodeSqliteKysely<DB>(database.db);
      const existing = executeSqliteQueryTakeFirstSync(
        database.db,
        query.selectFrom("transcript_events").select("seq").where("session_id", "=", id).limit(1),
      );
      if (!existing) {
        agent.runOpenClawAgentWriteTransaction((current) => {
          backfillSessionColdNavigationInTransaction(
            current,
            readSessionColdTranscript(current.db, id)!,
          );
        }, options);
      }
    }
  }
  const read = (index: number) => {
    const result = readCurrentProjectionSnapshot(
      database,
      {
        agentId: options.agentId,
        databaseAgentId: options.agentId,
        path: options.path,
        sessionId: sessionId(index),
        sessionKey: `agent:synthetic:${sessionId(index)}`,
      },
      (projection, cold) => {
        if (cold) {
          projection.readColdPayload = createSessionColdPayloadReader(database, sessionId(index));
        }
        projection.resolveVisibleHistory = resolveWorkerVisibleHistoryProjection;
        return readSessionTranscriptHistoryEventPageFromProjection(projection, {
          maxMessages: 40,
          offset: 0,
          maxBytes: 256 * 1024,
        });
      },
      undefined,
      { allowCold: true },
    );
    assert.equal(result.kind, "value");
    if (result.kind !== "value") {
      throw new Error("Synthetic projection unavailable");
    }
    return result.value;
  };
  const run = async (iteration: number) => {
    const index = iteration % fixture.sessions;
    if (values.arm === "retained") {
      return read(index);
    }
    const id = sessionId(index);
    const archive = readSessionColdTranscript(database.db, id)!;
    const plan = {
      kind: "cold-restore" as const,
      databaseOptions: options,
      sessionId: id,
      archive,
    };
    const records = await owner.prepareSessionColdRestoreInWorker(plan);
    let result: ReturnType<typeof read> | undefined;
    try {
      agent.runOpenClawAgentWriteTransaction(() => {
        assert(owner.mutateSessionColdTranscriptInWorker(plan, records, () => {}).restored);
        result = read(index);
        throw rollback;
      }, options);
    } catch (error) {
      if (error !== rollback) {
        throw error;
      }
    }
    assert(result);
    return result;
  };
  const expected = await run(0);
  assert.equal(expected.events.length, 40);
  assert.partialDeepStrictEqual(expected.events[0]?.event, { id: `event-${fixture.events - 40}` });
  assert.partialDeepStrictEqual(expected.events.at(-1)?.event, {
    id: `event-${fixture.events - 1}`,
  });
  const digest = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
  for (let index = 0; index < 5; index++) {
    await run(index);
  }
  globalThis.gc();
  const inspector = values.allocation ? new Session() : undefined;
  if (inspector) {
    await startCollectedHeapSampling(inspector, 32768);
  }
  const gc = values.allocation ? undefined : new GCProfiler();
  gc?.start();
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  const latency: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const begin = performance.now();
    const result = await run(index);
    latency.push(performance.now() - begin);
    assert.equal(result.events.length, 40);
  }
  const elapsedMs = performance.now() - started;
  const cpuUsed = process.threadCpuUsage(cpu);
  const collections = gc?.stop()?.statistics ?? [];
  const memoryAfter = process.memoryUsage();
  let allocatedBytes: number | undefined;
  let allocationSamples: number | undefined;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
    allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    allocationSamples = profile.samples.length;
  }
  const sorted = latency.toSorted((a, b) => a - b);
  return {
    scope: "page owner; restore includes rollback, excludes transport and durable commit",
    arm: values.arm,
    allocationPass: Boolean(values.allocation),
    fixture,
    iterations,
    responseDigest: digest,
    elapsedMs,
    threadCpuUsPerOp: (cpuUsed.user + cpuUsed.system) / iterations,
    allocatedBytesPerOp: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    allocationSamples,
    latencyMs: {
      p50: sorted[Math.ceil(iterations * 0.5) - 1],
      p99: sorted[Math.ceil(iterations * 0.99) - 1],
      samples: iterations,
    },
    gc: [...new Set(collections.map((entry) => entry.gcType))].map((kind) => {
      const pauses = collections
        .filter((entry) => entry.gcType === kind)
        .map((entry) => entry.cost / 1000);
      return {
        kind,
        count: pauses.length,
        totalMs: pauses.reduce((sum, cost) => sum + cost, 0),
        maxMs: Math.max(...pauses),
      };
    }),
    memoryBefore,
    memoryAfter,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  };
}

try {
  const result =
    values.action === "prepare"
      ? await prepare()
      : values.action === "storage"
        ? storage()
        : values.action === "measure"
          ? await measure()
          : assert.fail("Unknown --action");
  console.log(JSON.stringify(result));
} finally {
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
}
