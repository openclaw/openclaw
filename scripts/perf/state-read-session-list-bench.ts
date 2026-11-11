/**
 * Warm subagent session-list owner benchmark over synthetic completed runs.
 * Run five interleaved baseline/candidate pairs with identical arguments:
 *   node --expose-gc --import ./scripts/tsx.mjs \
 *     scripts/perf/state-read-session-list-bench.ts --rows 1000 --iterations 2000
 * --owner <module path> selects a prepared owner revision with resolvable imports.
 * --allocations selects collected-object sampling instead of untraced CPU timing;
 * never compare sampled timings. --rows 10000 matches the full-worker census.
 * This measures the actual SQL projection and decoder, with warm schema admission
 * and prepared statements, excluding transport, Gateway scheduling and model turns.
 * Forced GC runs only outside measurement. Reply digests preserve Map iteration
 * and object field order, and the fixture retains bodies that the projection omits.
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
    rows: { type: "string", default: "1000" },
    iterations: { type: "string", default: "2000" },
    warmup: { type: "string", default: "200" },
    allocations: { type: "boolean", default: false },
    owner: { type: "string" },
  },
});
const rows = parseStrictIntegerOption({
  raw: values.rows,
  label: "--rows",
  min: 1,
  fallback: 1000,
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
  : new URL(
      "../../src/agents/subagents/registry/subagent-registry.store.sqlite.ts",
      import.meta.url,
    );
const ownerSourceSha256 = createHash("sha256").update(readFileSync(ownerUrl)).digest("hex");
const owner = (await import(
  ownerUrl.href
)) as typeof import("../../src/agents/subagents/registry/subagent-registry.store.sqlite.js");
using db = openNodeSqliteDatabase(":memory:");
db.exec(
  extractSqliteTableSchema(
    readFileSync(new URL("../../src/state/openclaw-state-schema.sql", import.meta.url), "utf8"),
    "subagent_runs",
  ),
);
db.exec("BEGIN");
const insert = db.prepare(`INSERT INTO subagent_runs
  (run_id, child_session_key, requester_session_key, created_at, payload_json)
  VALUES (?, ?, 'agent:main:parent', ?, ?)`);
try {
  for (let index = 0; index < rows; index++) {
    insert.run(
      `run-${index}`,
      `agent:main:synthetic-${index}`,
      index + 1,
      JSON.stringify({
        createdAt: index + 1,
        execution: {
          status: "terminal",
          startedAt: index + 1,
          endedAt: index + 2,
          outcome: { status: "ok" },
        },
        completion: { required: false, resultText: "Synthetic retained result. ".repeat(80) },
        delivery: { status: "not_required" },
      }),
    );
  }
  db.exec("COMMIT");
} finally {
  disposeSqliteStatement(insert);
}
enableNodeSqliteKyselyStatementCache(db);
admitSqliteSchema(db);
function read() {
  return runSqliteReadOperationSync(db, () =>
    owner.loadSubagentSessionListRunsFromSqlite(undefined, { db }),
  );
}
const expected = read();
assert.equal(expected.size, rows);
let rowIndex = 0;
for (const [key, entry] of expected) {
  assert.equal(key, `run-${rowIndex}`);
  assert.equal(entry.childSessionKey, `agent:main:synthetic-${rowIndex++}`);
  assert.equal(entry.execution.status, "terminal");
}
const replySha256 = createHash("sha256")
  .update(JSON.stringify([...expected]))
  .digest("hex");
function run(count: number): number {
  let returnedRows = 0;
  for (let index = 0; index < count; index++) {
    returnedRows += read().size;
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
assert.equal(returnedRows, iterations * rows);
assert.equal(
  createHash("sha256")
    .update(JSON.stringify([...read()]))
    .digest("hex"),
  replySha256,
);
await nextTurn();
global.gc();
const memoryAfter = process.memoryUsage();
console.log(
  JSON.stringify({
    workload: "warm subagent session-list SQL projection and decoding",
    ownerSourceSha256,
    replySha256,
    host: hostname(),
    node: process.version,
    availableParallelism: availableParallelism(),
    loadBefore,
    loadAfter: loadavg(),
    rows,
    iterations,
    warmup,
    returnedRows,
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
