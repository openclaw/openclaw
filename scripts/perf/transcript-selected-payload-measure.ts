/**
 * Selected transcript read owners over synthetic SQLite rows, not Gateway transport.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-selected-payload-measure.ts
 *   --iterations 2000 --mode timing [--request checkpoint|rows|storage]
 * Repeat separately with --mode allocation; alternate base/candidate launch order.
 * --baseline-dir <absolute-overlay> substitutes a saved session-accessor.sqlite-read.ts
 * under src/config/sessions/ using worker-retained-heap-preload.ts. No second install.
 * Each request class reads a 64-row transcript containing identity and compressed assistant,
 * tool-call/result and compaction records. Fixtures, verification and warmup are unmeasured.
 * Acceptance: identical response digests, lower allocated bytes/op, no material CPU rise.
 * Timing reports thread CPU, GC counts/total/max and host load; allocation samples include
 * objects collected by minor and major GC. Allocation-pass timing is context only.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    mode: { type: "string", default: "timing" },
    request: { type: "string" },
    "baseline-dir": { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 2000,
  min: 1,
  label: "iterations",
});
assert(values.mode === "timing" || values.mode === "allocation");
assert(globalThis.gc, "Run with --expose-gc");
const ownerPath = "src/config/sessions/session-accessor.sqlite-read.ts";
const source = values["baseline-dir"]
  ? path.resolve(values["baseline-dir"], ownerPath)
  : fileURLToPath(new URL(`../../${ownerPath}`, import.meta.url));
const sourceDigest = createHash("sha256").update(readFileSync(source)).digest("hex");
if (values["baseline-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["baseline-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.js");
const { admitSqliteSchema } = await import("../../src/infra/sqlite-schema-facts.js");
const { configureSqliteWalMaintenance } = await import("../../src/infra/sqlite-wal.js");
const { resolveZstdCodec } = await import("../../src/infra/zstd-codec.js");
const {
  readTranscriptEventAtSeqInTransaction,
  readTranscriptEventRows,
  readTranscriptStorageRows,
} = await import("../../src/config/sessions/session-accessor.sqlite-read.js");

using db = openNodeSqliteDatabase(":memory:");
db.exec(`CREATE TABLE transcript_events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT,
  event_zstd BLOB, event_utf8_bytes INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE session_transcript_cold_archives (
  session_id TEXT PRIMARY KEY, generation TEXT, archive_name TEXT, archive_sha256 TEXT,
  event_count INTEGER, raw_bytes INTEGER, archive_bytes INTEGER, last_seq INTEGER,
  archived_at INTEGER, storage TEXT
);`);
admitSqliteSchema(db);
const database = {
  db,
  agentId: "synthetic",
  path: ":memory:",
  walMaintenance: configureSqliteWalMaintenance(db, { checkpointIntervalMs: 0 }),
};
const sessionId = "synthetic-long-transcript";
const text = "Synthetic café 雪 🦞 output. ".repeat(128);
const events = Array.from({ length: 64 }, (_, seq) => {
  const id = `event-${seq}`;
  const parentId = seq === 0 ? null : `event-${seq - 1}`;
  if (seq === 0) {
    return { type: "session", id: sessionId, version: 3 };
  }
  if (seq % 16 === 0) {
    return {
      type: "compaction",
      id,
      parentId,
      summary: text,
      firstKeptEntryId: `event-${seq - 4}`,
    };
  }
  const message =
    seq % 3 === 0
      ? { role: "assistant", content: [{ type: "text", text }] }
      : seq % 3 === 1
        ? {
            role: "assistant",
            content: [{ type: "toolCall", id: `call-${seq}`, name: "read", arguments: { text } }],
          }
        : {
            role: "toolResult",
            toolCallId: `call-${seq - 1}`,
            toolName: "read",
            content: [{ type: "text", text: text.repeat(2) }],
          };
  return { type: "message", id, parentId, message };
});
const json = events.map((event) => JSON.stringify(event));
const insert = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?, ?)");
const codec = resolveZstdCodec();
let compressedRows = 0;
for (const [seq, eventJson] of json.entries()) {
  const compressed = seq % 4 !== 0;
  const bytes = Buffer.from(eventJson);
  insert.run(
    sessionId,
    seq,
    compressed ? null : eventJson,
    compressed ? codec.compress(bytes, 1, true) : null,
    bytes.byteLength,
    seq * 1000,
  );
  compressedRows += Number(compressed);
}
const expectedRows = json.map((eventJson, seq) => ({ eventJson, seq }));
const expectedStorage = expectedRows.map((row) => ({ createdAt: row.seq * 1000, ...row }));
const requests = [
  {
    name: "checkpoint",
    read: (index: number) => readTranscriptEventAtSeqInTransaction(database, sessionId, index % 64),
    expected: (index: number) => ({ event: events[index % 64], seq: index % 64 }),
  },
  {
    name: "rows",
    read: (_index: number) => readTranscriptEventRows(database, sessionId),
    expected: (_index: number) => expectedRows,
  },
  {
    name: "storage",
    read: (_index: number) => readTranscriptStorageRows(database, sessionId),
    expected: (_index: number) => expectedStorage,
  },
];
assert(!values.request || requests.some((request) => request.name === values.request));
for (const request of requests) {
  if (values.request && values.request !== request.name) {
    continue;
  }
  const digest = createHash("sha256");
  for (let index = 0; index < 64; index++) {
    const result = request.read(index);
    assert.deepEqual(result, request.expected(index));
    digest.update(JSON.stringify(result));
  }
  for (let index = 0; index < 100; index++) {
    request.read(index);
  }
  globalThis.gc();
  const inspector = values.mode === "allocation" ? new Session() : undefined;
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const gc = new GCProfiler();
  gc.start();
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  let last: unknown;
  for (let index = 0; index < iterations; index++) {
    last = request.read(index);
  }
  const elapsedMs = performance.now() - started;
  const cpuUsage = process.threadCpuUsage(cpu);
  const collections = gc.stop()?.statistics ?? [];
  const memoryAfter = process.memoryUsage();
  let allocatedBytes: number | undefined;
  let allocationSamples: number | undefined;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
    allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    allocationSamples = profile.samples.length;
  }
  assert.deepEqual(last, request.expected(iterations - 1));
  console.log(
    JSON.stringify({
      request: request.name,
      mode: values.mode,
      sourceDigest,
      responseDigest: digest.digest("hex"),
      iterations,
      rows: json.length,
      compressedRows,
      fixtureBytes: json.reduce((sum, eventJson) => sum + Buffer.byteLength(eventJson), 0),
      elapsedMs,
      cpuUsPerOp: (cpuUsage.user + cpuUsage.system) / iterations,
      allocatedBytesPerOp: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      allocationSamples,
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
      node: process.version,
    }),
  );
}
await database.walMaintenance.stop();
database.walMaintenance.close();
