/**
 * Active transcript read owners over synthetic SQLite state, without Gateway transport.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-active-read-measure.ts
 *   --iterations 2000 --mode timing [--request recent|tail|accounting]
 * Repeat separately with --mode allocation; counterbalance base/candidate launch order.
 * --baseline-dir <absolute-overlay> substitutes saved source files under src/config/sessions/
 * through worker-retained-heap-preload.ts, without a second checkout or dependency install.
 * The fixture has 512 linked events (tool calls/results, usage and compaction markers),
 * mixed identity/compressed bodies, 64-event pages and the bounded 512-event accounting tail. Setup, checks and warmup
 * are unmeasured. Acceptance: identical reply digests, lower bytes/op, no material CPU rise.
 * Allocation sampling includes collected objects. Its CPU/GC timing is context only;
 * use the separate untraced timing pass for CPU and GC comparisons.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import type { CurrentTranscriptProjection } from "../../src/config/sessions/session-accessor.sqlite-projection-read.js";
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
const root = fileURLToPath(new URL("../../", import.meta.url));
const baseline = values["baseline-dir"] && path.resolve(values["baseline-dir"]);
const ownerPaths = [
  "src/config/sessions/session-accessor.sqlite-active-events-read.ts",
  "src/config/sessions/session-accessor.sqlite-active-events.ts",
  "src/config/sessions/session-transcript-accounting.ts",
];
const sourceDigest = createHash("sha256");
for (const owner of ownerPaths) {
  const saved = baseline && path.join(baseline, owner);
  sourceDigest
    .update(owner)
    .update(readFileSync(saved && existsSync(saved) ? saved : path.join(root, owner)));
}
const sourceHash = sourceDigest.digest("hex");
if (baseline) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = baseline;
  await import("./worker-retained-heap-preload.ts");
}
const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.js");
const { admitSqliteSchema } = await import("../../src/infra/sqlite-schema-facts.js");
const { runSqliteReadSnapshotSync } = await import("../../src/infra/sqlite-transaction.js");
const { resolveZstdCodec } = await import("../../src/infra/zstd-codec.js");
const {
  withRecentSessionTranscriptActiveEventsInSnapshot,
  readSessionTranscriptBoundedMessageTailPageFromProjection,
} = await import("../../src/config/sessions/session-accessor.sqlite-active-events-read.js");
const { readSessionTranscriptAccountingFromProjection } =
  await import("../../src/config/sessions/session-transcript-accounting.js");

using db = openNodeSqliteDatabase(":memory:");
db.exec(`CREATE TABLE transcript_events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT,
  event_zstd BLOB, event_utf8_bytes INTEGER, PRIMARY KEY (session_id, seq)
);
CREATE TABLE session_transcript_active_events (
  session_id TEXT NOT NULL, event_seq INTEGER NOT NULL, active_position INTEGER NOT NULL,
  message_position INTEGER, context_eligible INTEGER NOT NULL,
  PRIMARY KEY (session_id, active_position)
);
CREATE INDEX active_messages ON session_transcript_active_events(session_id, message_position);
CREATE INDEX active_sequences ON session_transcript_active_events(session_id, event_seq);`);
admitSqliteSchema(db);
const sessionId = "synthetic-long-transcript";
const text = "Synthetic café 雪 🦞 output. ".repeat(128);
const events = Array.from({ length: 512 }, (_, seq) => {
  const id = `event-${seq}`;
  const parentId = seq === 0 ? null : `event-${seq - 1}`;
  if (seq === 0) {
    return { type: "session", id: sessionId, version: 3 };
  }
  if (seq % 64 === 0) {
    return {
      type: "compaction",
      id,
      parentId,
      summary: text,
      firstKeptEntryId: `event-${seq - 4}`,
    };
  }
  const message =
    seq % 4 === 0
      ? { role: "user", content: text }
      : seq % 4 === 1
        ? {
            role: "assistant",
            content: [{ type: "toolCall", id: `call-${seq}`, name: "read", arguments: { text } }],
          }
        : seq % 4 === 2
          ? {
              role: "toolResult",
              toolCallId: `call-${seq - 1}`,
              toolName: "read",
              content: [{ type: "text", text: text.repeat(2) }],
            }
          : {
              role: "assistant",
              content: [{ type: "text", text }],
              usage: {
                input: 12000,
                output: 400,
                cacheRead: 8000,
                cacheWrite: 0,
                totalTokens: 20400,
              },
            };
  return { type: "message", id, parentId, message };
});
const json = events.map((event) => JSON.stringify(event));
const insert = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)");
const insertActive = db.prepare(
  "INSERT INTO session_transcript_active_events VALUES (?, ?, ?, ?, ?)",
);
const codec = resolveZstdCodec();
const messages: Array<{ event: TranscriptEvent; eventSeq: number; seq: number }> = [];
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
  );
  const event = events[seq]!;
  const messagePosition = event.type === "message" ? messages.length : null;
  insertActive.run(sessionId, seq, seq, messagePosition, 1);
  if (messagePosition !== null) {
    messages.push({ event, eventSeq: seq, seq: messagePosition + 1 });
  }
  compressedRows += Number(compressed);
}
const projection: CurrentTranscriptProjection = {
  database: { db, agentId: "synthetic", path: ":memory:" },
  generation: "synthetic-generation",
  version: { generation: "synthetic-generation", rawSeq: events.length - 1, updatedAt: 1 },
  hasUnindexedPrefix: false,
  latestIndexedReset: null,
  resolved: { agentId: "synthetic", sessionId, sessionKey: "agent:synthetic:transcript" },
  state: {
    activeEventCount: events.length,
    activeMessageCount: messages.length,
    indexedSeq: events.length - 1,
    leafEventId: "event-511",
    needsRebuild: false,
  },
};
const expectedTail = (offset: number) => {
  const selected = messages.slice(messages.length - offset - 64, messages.length - offset);
  return {
    activeLeafEntryId: projection.state.leafEventId,
    events: selected,
    newestContiguousEventCount: 64,
    scannedMessages: 64,
    serializedBytes: selected.reduce(
      (sum, row) => sum + Buffer.byteLength(json[row.eventSeq]!) + 1,
      0,
    ),
    snapshot: {
      boundarySeq: undefined,
      generation: projection.generation,
      indexedSeq: projection.state.indexedSeq,
    },
    totalMessages: messages.length,
  };
};
const requests = [
  {
    name: "recent",
    read: (_index: number) =>
      withRecentSessionTranscriptActiveEventsInSnapshot(projection, 64, (visit) => {
        const result: TranscriptEvent[] = [];
        visit((event) => result.push(event));
        return result;
      }),
    expected: (_index: number) => events.slice(-64).toReversed(),
  },
  {
    name: "tail",
    read: (index: number) =>
      readSessionTranscriptBoundedMessageTailPageFromProjection(projection, {
        maxBytes: 1024 * 1024,
        maxMessages: 64,
        offset: index % 4,
      }),
    expected: (index: number) => expectedTail(index % 4),
  },
  {
    name: "accounting",
    read: (_index: number) =>
      readSessionTranscriptAccountingFromProjection(projection, {
        includeByteSize: false,
        includeUsage: true,
        includeTurnTaint: true,
      }),
    expected: (_index: number) => ({
      usage: { promptTokens: 20000, outputTokens: 400, trailingMessages: [] },
      turnTainted: false,
    }),
  },
];
assert(!values.request || requests.some((request) => request.name === values.request));
for (const request of requests) {
  if (values.request && values.request !== request.name) {
    continue;
  }
  const read = (index: number) => runSqliteReadSnapshotSync(db, () => request.read(index));
  const digest = createHash("sha256");
  for (let index = 0; index < 4; index++) {
    const result = read(index);
    assert.deepEqual(result, request.expected(index));
    digest.update(JSON.stringify(result));
  }
  for (let index = 0; index < 100; index++) {
    read(index);
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
    last = read(index);
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
      sourceHash,
      responseDigest: digest.digest("hex"),
      iterations,
      rows: events.length,
      compressedRows,
      rowsPerRead: request.name === "accounting" ? 512 : 64,
      fixtureBytes: json.reduce((sum, value) => sum + Buffer.byteLength(value), 0),
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
