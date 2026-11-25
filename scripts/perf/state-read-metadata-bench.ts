/**
 * Warm ACP metadata owner benchmark over 10,000 synthetic SQLite rows.
 * Run alternating baseline/candidate processes with identical arguments:
 *   node --expose-gc --import ./scripts/tsx.mjs \
 *     scripts/perf/state-read-metadata-bench.ts --iterations 2000
 * --owner <module path> selects a prepared owner revision. --allocations runs
 * collected-object sampling instead of the untraced CPU pass; never compare
 * sampled timings. --direct selects the standalone metadata reader used by
 * shared session facts; the default includes per-request metadata preparation.
 * Each request selects 500 entries with their canonical key from 10k rows.
 * Admission and statements are warm; this excludes cold schema inspection,
 * worker transport, Gateway scheduling, and model turns. Forced GC occurs only
 * outside measured work. Retention is whole-isolate heap, not row-only memory.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { availableParallelism, hostname, loadavg } from "node:os";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildAcpDatabaseSessionKey } from "../../src/acp/runtime/session-meta-keys.js";
import type { AcpSessionReadCommand } from "../../src/acp/runtime/session-meta-read.types.js";
import {
  disposeSqliteStatement,
  enableNodeSqliteKyselyStatementCache,
} from "../../src/infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import {
  admitSqliteSchema,
  runSqliteReadOperationSync,
} from "../../src/infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../../src/infra/sqlite-schema-sql.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    warmup: { type: "string", default: "200" },
    allocations: { type: "boolean", default: false },
    direct: { type: "boolean", default: false },
    owner: { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 2000,
});
const warmup = parseStrictIntegerOption({
  raw: values.warmup,
  label: "--warmup",
  min: 1,
  fallback: 200,
});
assert(global.gc, "Run with --expose-gc");
const ownerUrl = values.owner
  ? pathToFileURL(resolve(values.owner))
  : new URL("../../src/acp/runtime/session-meta-read.worker.ts", import.meta.url);
const ownerSourceSha256 = createHash("sha256").update(readFileSync(ownerUrl)).digest("hex");
const owner = (await import(
  ownerUrl.href
)) as typeof import("../../src/acp/runtime/session-meta-read.worker.js");
const rows = 10_000;
const batchSize = 500;
const keys = Array.from({ length: rows }, (_, index) =>
  buildAcpDatabaseSessionKey(`agent:main:synthetic-${index}`, "main"),
);
const commands: Extract<AcpSessionReadCommand, { type: "acpSessions.metadata" }>[] = Array.from(
  { length: rows / batchSize },
  (_, batch) => ({
    type: "acpSessions.metadata",
    entries: keys.slice(batch * batchSize, (batch + 1) * batchSize).map((key) => ({
      keys: [key],
      entry: { sessionId: "synthetic-session", lifecycleRevision: "synthetic-generation" },
    })),
  }),
);
using db = openNodeSqliteDatabase(":memory:");
db.exec(
  extractSqliteTableSchema(
    readFileSync(new URL("../../src/state/openclaw-state-schema.sql", import.meta.url), "utf8"),
    "acp_sessions",
  ),
);
db.exec("BEGIN");
const insert = db.prepare(`INSERT INTO acp_sessions
  (session_key, session_id, backend, agent, runtime_session_name, mode, state,
   last_activity_at, updated_at, runtime_options_json)
  VALUES (?, 'synthetic-generation', 'fixture', 'main', ?, 'persistent', 'idle', 100, 100, ?)`);
for (const [index, key] of keys.entries()) {
  insert.run(key, `synthetic-runtime-${index}`, '{"model":"fixture-model"}');
}
db.exec("COMMIT");
disposeSqliteStatement(insert);
enableNodeSqliteKyselyStatementCache(db);
admitSqliteSchema(db);

function read(command: (typeof commands)[number]) {
  const prepared = values.direct ? undefined : owner.prepareAcpSessionMetadataRead(command);
  return runSqliteReadOperationSync(db, () =>
    prepared ? prepared.read(db) : owner.readAcpSessionCommand(db, command),
  );
}
for (const command of commands) {
  const result = read(command);
  assert(result.type === "acpSessions.metadata");
  assert.deepEqual(
    result.rows.map((row) => row?.session_key),
    command.entries.map((entry) => entry.keys[0]),
  );
}
function run(count: number): number {
  let returnedRows = 0;
  for (let index = 0; index < count; index++) {
    returnedRows += read(commands[index % commands.length]!).rows.length;
  }
  return returnedRows;
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
}
run(warmup);
await nextTurn();
global.gc();
const memoryBefore = process.memoryUsage();
const loadBefore = loadavg();
const inspector = new Session();
let allocatedBytes: number | undefined;
let cpuUs: number | undefined;
let elapsedMs: number | undefined;
let returnedRows = 0;
try {
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    returnedRows = run(iterations);
    allocatedBytes = allocated((await inspector.post("HeapProfiler.stopSampling")).profile.head);
  } else {
    const cpuBefore = process.threadCpuUsage();
    const started = performance.now();
    returnedRows = run(iterations);
    elapsedMs = performance.now() - started;
    const cpu = process.threadCpuUsage(cpuBefore);
    cpuUs = cpu.user + cpu.system;
  }
} finally {
  inspector.disconnect();
}
assert.equal(returnedRows, iterations * batchSize);
await nextTurn();
global.gc();
const memoryAfter = process.memoryUsage();
console.log(
  JSON.stringify({
    workload: "warm ACP metadata with canonical keys",
    ownerSourceSha256,
    host: hostname(),
    node: process.version,
    availableParallelism: availableParallelism(),
    loadBefore,
    loadAfter: loadavg(),
    rows,
    batchSize,
    keysPerEntry: 1,
    iterations,
    warmup,
    returnedRows,
    direct: values.direct,
    allocationSampling: values.allocations,
    elapsedMs,
    ownerCpuUsPerOperation: cpuUs === undefined ? undefined : cpuUs / iterations,
    allocatedBytes,
    allocatedBytesPerOperation:
      allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    retainedHeapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    memoryBefore,
    memoryAfter,
  }),
);
