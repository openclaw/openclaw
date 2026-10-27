/**
 * Owner-level cold restore memory proof; synthetic state only, no Gateway or live state.
 * Prepare in a separate process so compression/fixture allocation cannot pollute VmHWM:
 *   node --import ./scripts/tsx.mjs scripts/perf/session-cold-restore-memory.ts \
 *     --prepare --state-dir "$PWD/.local/cold-fixture" --sessions 4 --chunks 2 --chunk-mib 60
 * Copy that closed fixture to a fresh directory before EACH measured process, then run:
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-cold-restore-memory.ts \
 *     --state-dir "$PWD/.local/cold-run" --requests 4 [--allocation] [--owner-module <path>]
 * --prepare --sessions 1 --events 20000 (also 100000/300000) prepares bounded 8 MiB chunks of mixed
 * user/assistant/tool history, one event per minute from 2024-01-01, instead of
 * filling --chunks. --profile measures native
 * SQL executions/preparations by table separately from untraced timing runs.
 * transactionTimings measures successful BEGIN IMMEDIATE through COMMIT/ROLLBACK;
 * PRAGMAs report configured page/cache/temp policy, not native cache hit counters.
 * Restored transcript and metadata hashes plus unchanged generation/window/node
 * snapshots are asserted after measurement. Fixture generation keeps one <=8 MiB
 * encoded chunk live in --events mode; compressed chunks are ordinary archive files.
 * --owner-module selects a frozen baseline worker module; all its changed dependencies
 * must also be frozen. Omit it for current source. Use >=5 alternating base/candidate
 * processes for timing/memory, and separate --allocation processes. --requests 1 is
 * one restore; larger values enqueue concurrent requests through the REAL process-wide
 * archive queue (which serializes them). This is an owner-kernel benchmark, not proof
 * of Gateway transport, whole-Gateway latency, or the native reclamation-worker pool.
 * One forced GC after imports/open is outside measurement; GC during restores is natural.
 * Main thread samples process RSS every 5ms while a worker executes real preparation
 * and the atomic write transaction. Per-isolate heap/external are sampled every 128
 * records and at phase boundaries; they are sampled lower bounds, not precise peaks.
 * Native proxy = RSS minus worker heapUsed and external; includes other isolates,
 * heap slack, SQLite and allocator retention. It is not native allocator accounting.
 * resourceUsage maxRSS includes module load; sampled RSS is bounded to the restore burst.
 * JSON output includes exact restored event-byte digest verification, counts, CPU,
 * natural GC time/count/max, heap/external, host load and allocation sampling separately.
 * CPU reports both the restore thread and the whole process (including GC helper threads).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { zstdCompressSync } from "node:zlib";
import type { SessionColdChunkMetadata } from "../../src/config/sessions/session-accessor.sqlite-archive-types.js";
import type { SessionColdRecord } from "../../src/config/sessions/session-cold-storage-codec.js";
import type { SqlConnection } from "../../src/infra/sql-connection.js";
import type { DB } from "../../src/state/openclaw-agent-db.generated.js";

const MiB = 1024 * 1024;
const { values } = parseArgs({
  options: {
    prepare: { type: "boolean" },
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "4" },
    chunks: { type: "string", default: "2" },
    "chunk-mib": { type: "string", default: "60" },
    requests: { type: "string", default: "1" },
    allocation: { type: "boolean" },
    profile: { type: "boolean" },
    events: { type: "string" },
    "owner-module": { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir is required");
const stateDir = path.resolve(values["state-dir"]);
const positive = (value: string, name: string) => {
  const number = Number(value);
  assert(Number.isSafeInteger(number) && number > 0, `${name} must be a positive integer`);
  return number;
};
const options = { agentId: "main", path: path.join(stateDir, "agent.sqlite") };
const manifestPath = path.join(stateDir, "fixture.json");
type Fixture = {
  sessions: {
    sessionId: string;
    digest: string;
    events: number;
    metadata?: Record<string, string>;
  }[];
  chunksPerSession: number;
  envelopeBytes: number[];
};

function isolateEnvironment() {
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_HOME = path.join(stateDir, "home");
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
  process.env.TMPDIR = path.join(stateDir, "tmp");
}

async function owners() {
  return Promise.all([
    import("../../src/state/openclaw-agent-db.js"),
    import("../../src/infra/kysely-sync.js"),
    import("../../src/config/sessions/session-cold-storage-codec.js"),
    import("../../src/state/openclaw-state-db.js"),
  ]);
}

async function prepare() {
  mkdirSync(stateDir, { mode: 0o700 });
  for (const directory of ["home", "tmp", "workspace"]) {
    mkdirSync(path.join(stateDir, directory));
  }
  writeFileSync(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      agents: { entries: { main: { workspace: path.join(stateDir, "workspace") } } },
    }),
  );
  isolateEnvironment();
  const [agent, queries, codec, state] = await owners();
  const { hashSessionColdChunks } =
    await import("../../src/config/sessions/session-cold-storage-chunks.js");
  const { replaceSessionEntrySync } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry.js");
  const sessions = positive(values.sessions, "sessions");
  const chunkCount = positive(values.chunks, "chunks");
  const eventLimit = values.events ? positive(values.events, "events") : undefined;
  const targetBytes = Math.min(
    positive(values["chunk-mib"], "chunk-mib") * MiB,
    eventLimit ? 8 * MiB : Infinity,
  );
  assert(targetBytes < codec.MAX_COLD_ARCHIVE_BYTES, "chunk-mib must be less than 64");
  const manifest: Fixture = { sessions: [], chunksPerSession: chunkCount, envelopeBytes: [] };
  const text = `${"synthetic cold history 🦞 ".repeat(2000)}\n`;
  try {
    for (let session = 0; session < sessions; session++) {
      const sessionId = `cold-memory-${session}`;
      const generation = `generation-${session}`;
      replaceSessionEntrySync(
        { agentId: "main", storePath: options.path, sessionKey: `agent:main:${sessionId}` },
        { sessionId, updatedAt: 1 },
      );
      const chunks: SessionColdChunkMetadata[] = [];
      const expected = createHash("sha256");
      const metadata = Object.fromEntries(
        ["identity", "active", "index", "fts"].map((kind) => [kind, createHash("sha256")]),
      );
      const eventId = (index: number) => `event-${String(index).padStart(8, "0")}`;
      let seq = 0;
      for (let chunk = 0; eventLimit ? seq < eventLimit : chunk < chunkCount; chunk++) {
        const lines = [
          JSON.stringify({ kind: "header", version: 1, sessionId, generation }) + "\n",
        ];
        const identityLines: string[] = [];
        const activeLines: string[] = [];
        const ftsLines: string[] = [];
        let envelopeBytes = Buffer.byteLength(lines[0]!);
        let rawBytes = 0;
        const firstSeq = seq;
        do {
          const role = eventLimit
            ? (["user", "assistant", "toolResult", "assistant"] as const)[seq % 4]!
            : "user";
          const body = eventLimit
            ? `synthetic event ${seq}: ${"tool output line 🦞\n".repeat(seq % 64 === 2 ? 800 : seq % 4 === 2 ? 80 : 8)}`
            : text;
          const createdAt = eventLimit ? Date.UTC(2024, 0, 1) + seq * 60_000 : seq + 1;
          const event = `{ "type": "message", "id": "${eventId(seq)}", "message": ${JSON.stringify({ role, content: [{ type: "text", text: body }] })} }`;
          const records: SessionColdRecord[] = [
            { kind: "event", row: { seq, event_json: event, created_at: createdAt } },
            {
              kind: "identity",
              row: {
                event_id: eventId(seq),
                seq,
                event_type: "message",
                parent_id: seq ? eventId(seq - 1) : null,
                message_idempotency_key: null,
                created_at: createdAt,
              },
            },
            {
              kind: "active",
              row: {
                active_position: seq,
                event_seq: seq,
                message_position: seq,
                context_eligible: 1,
              },
            },
            {
              kind: "fts",
              row: { text: body, message_id: eventId(seq), role, timestamp: createdAt },
            },
          ];
          const encoded = records.map((record) => `${JSON.stringify(record)}\n`);
          const size = encoded.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
          if (seq > firstSeq && envelopeBytes + size > targetBytes) {
            break;
          }
          for (const record of records) {
            if (record.kind !== "header" && record.kind !== "event") {
              metadata[record.kind]!.update(`${JSON.stringify(record.row)}\n`);
            }
          }
          lines.push(encoded[0]!);
          identityLines.push(encoded[1]!);
          activeLines.push(encoded[2]!);
          ftsLines.push(encoded[3]!);
          envelopeBytes += size;
          rawBytes += Buffer.byteLength(event);
          expected.update(`${JSON.stringify([seq, event, createdAt])}\n`);
          seq++;
        } while (envelopeBytes < targetBytes && seq < (eventLimit ?? Infinity));
        // Match the cold archive producer: records are grouped by kind, not interleaved.
        if (eventLimit ? seq === eventLimit : chunk === chunkCount - 1) {
          const row = {
            indexed_seq: seq - 1,
            leaf_event_id: eventId(seq - 1),
            needs_rebuild: 0,
            active_event_count: seq,
            active_message_count: seq,
            updated_at: 1,
          };
          const index = `${JSON.stringify({ kind: "index", row })}\n`;
          metadata.index!.update(`${JSON.stringify(row)}\n`);
          activeLines.push(index);
          envelopeBytes += Buffer.byteLength(index);
        }
        const payload = zstdCompressSync(
          Buffer.from(
            lines.join("") + identityLines.join("") + activeLines.join("") + ftsLines.join(""),
          ),
        );
        const sha256 = createHash("sha256").update(payload).digest("hex");
        const archiveName = `${sha256}.jsonl.zst`;
        const archivePath = codec.resolveSessionColdArchivePath(options.path, archiveName);
        mkdirSync(path.dirname(archivePath), { recursive: true });
        writeFileSync(archivePath, payload);
        chunks.push({
          session_id: sessionId,
          chunk_index: chunk,
          archive_name: archiveName,
          archive_sha256: sha256,
          first_seq: firstSeq,
          last_seq: seq - 1,
          event_count: seq - firstSeq,
          raw_bytes: rawBytes + seq - firstSeq - 1,
          archive_bytes: payload.length,
        });
        manifest.envelopeBytes.push(envelopeBytes);
      }
      const hash = hashSessionColdChunks(chunks);
      agent.runOpenClawAgentWriteTransaction(({ db }) => {
        const sql = queries.getNodeSqliteKysely<DB>(db);
        queries.executeSqliteQuerySync(
          db,
          sql.insertInto("session_transcript_cold_archives").values({
            session_id: sessionId,
            generation,
            archive_name: `${hash}.jsonl.zst`,
            archive_sha256: hash,
            event_count: seq,
            raw_bytes: chunks.reduce((sum, chunk) => sum + chunk.raw_bytes, chunks.length - 1),
            archive_bytes: chunks.reduce((sum, chunk) => sum + chunk.archive_bytes, 0),
            last_seq: seq - 1,
            archived_at: 1,
            storage: "file",
            archive_blob: null,
          }),
        );
        for (const chunk of chunks) {
          queries.executeSqliteQuerySync(
            db,
            sql
              .insertInto("session_transcript_cold_archive_chunks")
              .values({ ...chunk, archive_blob: null }),
          );
        }
      }, options);
      manifest.chunksPerSession = chunks.length;
      manifest.sessions.push({
        sessionId,
        digest: expected.digest("hex"),
        events: seq,
        metadata: Object.fromEntries(
          Object.entries(metadata).map(([key, digest]) => [key, digest.digest("hex")]),
        ),
      });
    }
  } finally {
    await agent.closeOpenClawAgentDatabasesAsync();
    await state.closeOpenClawStateDatabaseAsync();
  }
  writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(JSON.stringify({ prepared: stateDir, ...manifest }));
}

function observeRestoreSql(database: SqlConnection, detailed: boolean) {
  const buckets: Record<
    string,
    { prepares: number; prepareMs: number; executions: number; sqlMs: number }
  > = {};
  const transactions: { holdMs: number; commitMs: number }[] = [];
  const classify = (sql: string) =>
    /\bmetadata\b/.test(sql) && sql.includes("navigation_json")
      ? "payload-navigation"
      : (/\b(?:into|from|update)\s+["`]?([a-z_]+)/i.exec(sql)?.[1] ?? "other");
  const bucket = (sql: string) =>
    (buckets[classify(sql)] ??= { prepares: 0, prepareMs: 0, executions: 0, sqlMs: 0 });
  const originalPrepare = database.prepare.bind(database);
  const originalExec = database.exec.bind(database);
  let transactionStart: number | undefined;
  let observing = true;
  database.exec = (sql) => {
    const started = performance.now();
    originalExec(sql);
    if (/^BEGIN IMMEDIATE\b/i.test(sql.trim())) {
      transactionStart = performance.now();
    } else if (/^(COMMIT|ROLLBACK)\b/i.test(sql.trim()) && transactionStart !== undefined) {
      transactions.push({
        holdMs: performance.now() - transactionStart,
        commitMs: performance.now() - started,
      });
      transactionStart = undefined;
    }
  };
  if (detailed) {
    database.prepare = (sql) => {
      const stat = bucket(sql);
      const prepareStarted = performance.now();
      const statement = originalPrepare(sql);
      stat.prepares++;
      stat.prepareMs += performance.now() - prepareStarted;
      for (const key of ["get", "all", "run"] as const) {
        statement[key] = new Proxy(statement[key], {
          apply(target, receiver, args) {
            if (!observing) {
              return Reflect.apply(target, receiver, args);
            }
            const started = performance.now();
            stat.executions++;
            try {
              return Reflect.apply(target, receiver, args);
            } finally {
              stat.sqlMs += performance.now() - started;
            }
          },
        });
      }
      const iterate = statement.iterate.bind(statement);
      statement.iterate = (...args) => {
        if (!observing) {
          return iterate(...args);
        }
        stat.executions++;
        const iterator = iterate(...args);
        return (function* () {
          try {
            for (;;) {
              const started = performance.now();
              const row = iterator.next();
              stat.sqlMs += performance.now() - started;
              if (row.done) {
                return;
              }
              yield row.value;
            }
          } finally {
            iterator.return?.(undefined);
          }
        })();
      };
      return statement;
    };
  }
  return {
    buckets,
    transactions,
    restore() {
      observing = false;
      database.prepare = originalPrepare;
      database.exec = originalExec;
    },
  };
}

function unchangedRows(database: SqlConnection) {
  return Object.fromEntries(
    ["transcript_rewrite_watermarks", "session_windows", "session_nodes"].map((table) => [
      table,
      database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ]),
  );
}

function verifyMetadata(database: SqlConnection, expected: Fixture["sessions"][number]) {
  const selections = {
    identity: [
      "transcript_event_identities",
      "event_id,seq,event_type,parent_id,message_idempotency_key,created_at",
      "seq,event_id",
    ],
    active: [
      "session_transcript_active_events",
      "active_position,event_seq,message_position,context_eligible",
      "active_position",
    ],
    index: [
      "session_transcript_index_state",
      "indexed_seq,leaf_event_id,needs_rebuild,active_event_count,active_message_count,updated_at",
      "session_id",
    ],
    fts: ["session_transcript_fts", "text,message_id,role,timestamp", "timestamp,message_id"],
  };
  for (const [kind, [table, columns, order]] of Object.entries(selections)) {
    const digest = createHash("sha256");
    for (const row of database
      .prepare(`SELECT ${columns} FROM ${table} WHERE session_id = ? ORDER BY ${order}`)
      .iterate(expected.sessionId)) {
      digest.update(`${JSON.stringify(row)}\n`);
    }
    assert.equal(digest.digest("hex"), expected.metadata?.[kind], `restored ${kind} changed`);
  }
}

async function measureWorker() {
  isolateEnvironment();
  const loaded = await owners();
  const agent = loaded[0];
  const queries = loaded[1];
  const state = loaded[3];
  const { readSessionColdTranscript } =
    await import("../../src/config/sessions/session-cold-storage-state.js");
  const { transcriptEventJsonSql } =
    await import("../../src/config/sessions/transcript-payload.js");
  const { runExclusiveSqliteTranscriptArchiveWorker } =
    await import("../../src/config/sessions/session-accessor.sqlite-archive.js");
  const owner: typeof import("../../src/config/sessions/session-cold-storage-worker.js") =
    await import(
      values["owner-module"]
        ? pathToFileURL(path.resolve(values["owner-module"])).href
        : "../../src/config/sessions/session-cold-storage-worker.js"
    );
  const manifest: Fixture = JSON.parse(readFileSync(manifestPath, "utf8"));
  const count = positive(values.requests, "requests");
  assert(count <= manifest.sessions.length, "requests exceeds prepared sessions");
  const database = agent.openOpenClawAgentDatabase(options);
  const unchanged = unchangedRows(database.db);
  const pragmas = Object.fromEntries(
    [
      "cache_size",
      "temp_store",
      "page_size",
      "page_count",
      "freelist_count",
      "journal_mode",
      "synchronous",
      "mmap_size",
    ].map((name) => [name, database.db.prepare(`PRAGMA ${name}`).get()]),
  );
  queries.clearNodeSqliteKyselyCacheForDatabase(database.db);
  const sqlProfile = observeRestoreSql(database.db, Boolean(values.profile));
  const peaks = {
    heapUsed: 0,
    heapTotal: 0,
    external: 0,
    arrayBuffers: 0,
    totalHeapSize: 0,
    nativeEstimate: 0,
  };
  const sample = () => {
    const memory = process.memoryUsage();
    const heap = getHeapStatistics();
    for (const key of ["heapUsed", "heapTotal", "external", "arrayBuffers"] as const) {
      peaks[key] = Math.max(peaks[key], memory[key]);
    }
    peaks.totalHeapSize = Math.max(peaks.totalHeapSize, heap.total_heap_size);
    peaks.nativeEstimate = Math.max(
      peaks.nativeEstimate,
      memory.rss - memory.heapUsed - memory.external,
    );
  };
  assert(global.gc, "Measurement requires --expose-gc");
  global.gc();
  const gc = {
    count: 0,
    ms: 0,
    maxMs: 0,
    byKind: {} as Record<string, { count: number; ms: number; maxMs: number }>,
  };
  let gcStart = Infinity;
  let gcEnd = Infinity;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.startTime < gcStart || entry.startTime > gcEnd) {
        continue;
      }
      gc.count++;
      gc.ms += entry.duration;
      gc.maxMs = Math.max(gc.maxMs, entry.duration);
      const detail: unknown = "detail" in entry ? entry.detail : undefined;
      const kind =
        detail && typeof detail === "object" && "kind" in detail ? String(detail.kind) : "unknown";
      const bucket = (gc.byKind[kind] ??= { count: 0, ms: 0, maxMs: 0 });
      bucket.count++;
      bucket.ms += entry.duration;
      bucket.maxMs = Math.max(bucket.maxMs, entry.duration);
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const inspector = new Session();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  parentPort!.postMessage({ type: "ready" }, []);
  await new Promise<void>((resolve) => {
    parentPort!.once("message", () => resolve());
  });
  const before = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  gcStart = started;
  let records = 0;
  await Promise.all(
    manifest.sessions.slice(0, count).map(({ sessionId }) =>
      runExclusiveSqliteTranscriptArchiveWorker(async () => {
        const archive = readSessionColdTranscript(database.db, sessionId);
        assert(archive, "fixture was already restored; use a fresh copy per measurement");
        const plan = {
          kind: "cold-restore" as const,
          databaseOptions: options,
          sessionId,
          archive,
        };
        const prepared = await owner.prepareSessionColdRestoreInWorker(plan);
        sample();
        const result = owner.mutateSessionColdTranscriptInWorker(
          plan,
          (current) =>
            (function* () {
              for (const record of prepared(current)) {
                if ((records++ & 127) === 0) {
                  sample();
                }
                yield record;
              }
            })(),
          () => {},
        );
        assert(result.restored);
        sample();
      }),
    ),
  );
  gcEnd = performance.now();
  const elapsedMs = gcEnd - started;
  sqlProfile.restore();
  const used = process.threadCpuUsage(cpu);
  parentPort!.postMessage({ type: "measured" }, []);
  await new Promise<void>((resolve) => {
    parentPort!.once("message", () => resolve());
  });
  // GC observer delivery is deferred until synchronous restore work yields.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 25);
  });
  observer.disconnect();
  let sampledAllocationBytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledAllocationBytes = profile.samples.reduce((sum, item) => sum + item.size, 0);
    inspector.disconnect();
  }
  const after = process.memoryUsage();
  const sql = queries.getNodeSqliteKysely<DB>(database.db);
  for (const expected of manifest.sessions.slice(0, count)) {
    const digest = createHash("sha256");
    let eventCount = 0;
    for (const row of queries.iterateSqliteQuerySync(
      database.db,
      sql
        .selectFrom("transcript_events")
        .select(["seq", "created_at", transcriptEventJsonSql(database.db).as("event_json")])
        .where("session_id", "=", expected.sessionId)
        .orderBy("seq"),
    )) {
      digest.update(`${JSON.stringify([row.seq, row.event_json, row.created_at])}\n`);
      eventCount++;
    }
    assert.equal(eventCount, expected.events);
    assert.equal(digest.digest("hex"), expected.digest, "restored transcript bytes changed");
    if (expected.metadata) {
      verifyMetadata(database.db, expected);
    }
  }
  assert.deepEqual(
    unchangedRows(database.db),
    unchanged,
    "restore changed generation, window or node rows",
  );
  parentPort!.postMessage(
    {
      type: "result",
      transactionTimings: sqlProfile.transactions,
      sqlProfile: values.profile ? sqlProfile.buckets : undefined,
      pragmas,
      pageCountAfter: database.db.prepare("PRAGMA page_count").get(),
      count,
      chunksPerSession: manifest.chunksPerSession,
      envelopeBytes: manifest.envelopeBytes.slice(0, count * manifest.chunksPerSession),
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      records,
      before,
      after,
      peaks,
      gc,
      sampledAllocationBytes,
      byteIdentical: true,
    },
    [],
  );
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
  parentPort!.close();
}

async function measure() {
  const hostLoadBefore = loadavg();
  let peakRss = 0;
  let baselineRss = 0;
  let processMaxRssBytes = 0;
  let processCpuBefore: NodeJS.CpuUsage | undefined;
  let processCpuMs = 0;
  let sampling: NodeJS.Timeout | undefined;
  const worker = new Worker(fileURLToPath(import.meta.url), {
    argv: process.argv.slice(2),
    workerData: true,
  });
  await new Promise<void>((resolve, reject) => {
    worker.on("error", reject);
    worker.on("message", (message) => {
      if (message.type === "ready") {
        assert(global.gc, "Measurement requires --expose-gc");
        global.gc();
        baselineRss = process.memoryUsage.rss();
        peakRss = baselineRss;
        sampling = setInterval(() => {
          peakRss = Math.max(peakRss, process.memoryUsage.rss());
        }, 5);
        processCpuBefore = process.cpuUsage();
        worker.postMessage("start", []);
      } else if (message.type === "measured") {
        const used = process.cpuUsage(processCpuBefore);
        processCpuMs = (used.user + used.system) / 1000;
        processMaxRssBytes = process.resourceUsage().maxRSS * 1024;
        peakRss = Math.max(peakRss, process.memoryUsage.rss());
        clearInterval(sampling);
        worker.postMessage("sampled", []);
      } else if (message.type === "result") {
        console.log(
          JSON.stringify({
            ...message,
            scope: "serialized owner restore kernels; no Gateway transport",
            node: process.version,
            ownerModule: values["owner-module"] ?? "current",
            allocationPass: Boolean(values.allocation),
            profilePass: Boolean(values.profile),
            baselineRss,
            peakRss,
            peakRssDelta: peakRss - baselineRss,
            processMaxRssBytes,
            processCpuMs,
            hostLoadBefore,
            hostLoadAfter: loadavg(),
          }),
        );
      }
    });
    worker.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Restore worker exited ${code}`)),
    );
  }).finally(() => clearInterval(sampling));
}

if (!isMainThread && workerData) {
  await measureWorker();
} else if (values.prepare) {
  await prepare();
} else {
  await measure();
}
