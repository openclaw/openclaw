/**
 * Owner-level cold restore memory proof; synthetic state only, no Gateway or live state.
 * Prepare in a separate process so compression/fixture allocation cannot pollute VmHWM:
 *   node --import ./scripts/tsx.mjs scripts/perf/session-cold-restore-memory.ts \
 *     --prepare --state-dir "$PWD/.local/cold-fixture" --sessions 4 --chunks 2 --chunk-mib 60
 * Copy that closed fixture to a fresh directory before EACH measured process, then run:
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-cold-restore-memory.ts \
 *     --state-dir "$PWD/.local/cold-run" --requests 4 [--allocation] [--owner-module <path>]
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
  sessions: { sessionId: string; digest: string; events: number }[];
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
  const targetBytes = positive(values["chunk-mib"], "chunk-mib") * MiB;
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
      let seq = 0;
      for (let chunk = 0; chunk < chunkCount; chunk++) {
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
          const event = `{ "type": "message", "id": "event-${seq}", "message": ${JSON.stringify({ role: "user", content: [{ type: "text", text }] })} }`;
          const records: SessionColdRecord[] = [
            { kind: "event", row: { seq, event_json: event, created_at: seq + 1 } },
            {
              kind: "identity",
              row: {
                event_id: `event-${seq}`,
                seq,
                event_type: "message",
                parent_id: seq ? `event-${seq - 1}` : null,
                message_idempotency_key: null,
                created_at: seq + 1,
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
              row: { text, message_id: `event-${seq}`, role: "user", timestamp: seq + 1 },
            },
          ];
          const encoded = records.map((record) => `${JSON.stringify(record)}\n`);
          const size = encoded.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
          if (seq > firstSeq && envelopeBytes + size > targetBytes) {
            break;
          }
          lines.push(encoded[0]!);
          identityLines.push(encoded[1]!);
          activeLines.push(encoded[2]!);
          ftsLines.push(encoded[3]!);
          envelopeBytes += size;
          rawBytes += Buffer.byteLength(event);
          expected.update(`${JSON.stringify([seq, event, seq + 1])}\n`);
          seq++;
        } while (envelopeBytes < targetBytes);
        // Match the cold archive producer: records are grouped by kind, not interleaved.
        lines.push(...identityLines, ...activeLines);
        if (chunk === chunkCount - 1) {
          const index = `${JSON.stringify({ kind: "index", row: { indexed_seq: seq - 1, leaf_event_id: `event-${seq - 1}`, needs_rebuild: 0, active_event_count: seq, active_message_count: seq, updated_at: 1 } })}\n`;
          lines.push(index);
          envelopeBytes += Buffer.byteLength(index);
        }
        lines.push(...ftsLines);
        const payload = zstdCompressSync(Buffer.from(lines.join("")));
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
      manifest.sessions.push({ sessionId, digest: expected.digest("hex"), events: seq });
    }
  } finally {
    await agent.closeOpenClawAgentDatabasesAsync();
    await state.closeOpenClawStateDatabaseAsync();
  }
  writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(JSON.stringify({ prepared: stateDir, ...manifest }));
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
  }
  parentPort!.postMessage(
    {
      type: "result",
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
