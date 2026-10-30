/**
 * Warm repository-workspace lookups across 10,000 synthetic SQLite rows.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/state-read-workspace-bench.ts
 * --iterations 5000 --owner <prepared owner module> selects a revision.
 * Add --allocations for a separate collected-object allocation sampling pass.
 * Alternate base/candidate processes; compare untraced CPU separately from allocation.
 * This runs the worker's query owner, not worker transport or a whole Gateway.
 * No result cache: owners alternate across 40 agents. Validation includes 40 misses.
 * Acceptance: identical result digest, fewer query constructions, lower allocation
 * and CPU per lookup. Forced GC is outside measured work; retain host-load context.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { hostname, loadavg } from "node:os";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { enableNodeSqliteKyselyStatementCache } from "../../src/infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import {
  admitSqliteSchema,
  runSqliteReadOperationSync,
} from "../../src/infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../../src/infra/sqlite-schema-sql.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "5000" },
    allocations: { type: "boolean", default: false },
    owner: { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 5000,
});
assert(global.gc, "Run with --expose-gc");
const ownerUrl = values.owner
  ? pathToFileURL(resolve(values.owner))
  : new URL("../../src/state/session-repository-workspaces.kernel.ts", import.meta.url);
const { findSessionRepositoryWorkspaceInDatabase: find } = (await import(
  ownerUrl.href
)) as typeof import("../../src/state/session-repository-workspaces.kernel.js");
const ownerSourceSha256 = createHash("sha256").update(readFileSync(ownerUrl)).digest("hex");
using db = openNodeSqliteDatabase(":memory:");
db.exec(
  extractSqliteTableSchema(
    readFileSync(new URL("../../src/state/openclaw-state-schema.sql", import.meta.url), "utf8"),
    "session_repository_workspaces",
  ),
);
const rowCount = 10_000;
const owners = Array.from({ length: rowCount + 40 }, (_, index) => ({
  agentId: `agent-${index % 40}`,
  sessionKey: `session-${Math.floor(index / 40)}`,
}));
db.exec("BEGIN");
const insert = db.prepare(`INSERT INTO session_repository_workspaces
  (workspace_id, agent_id, session_key, url, branch, revision, created_at_ms, updated_at_ms)
  VALUES (?, ?, ?, 'https://example.test/repository.git', 'synthetic-branch', 0, 1, 1)`);
for (let index = 0; index < rowCount; index++) {
  const owner = owners[index]!;
  insert.run(
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    owner.agentId,
    owner.sessionKey,
  );
}
db.exec("COMMIT");
enableNodeSqliteKyselyStatementCache(db);
admitSqliteSchema(db);
const digest = createHash("sha256");
for (const [index, owner] of owners.entries()) {
  const row = runSqliteReadOperationSync(db, () => find(db, owner));
  assert.equal(
    row?.workspaceId,
    index < rowCount ? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` : undefined,
  );
  digest.update(JSON.stringify(row) ?? "absent");
}
function run(count: number) {
  let found = 0;
  for (let index = 0; index < count; index++) {
    found += runSqliteReadOperationSync(db, () => find(db, owners[index % owners.length]!)) ? 1 : 0;
  }
  return found;
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
await nextTurn();
global.gc();
const memoryBefore = process.memoryUsage();
const loadBefore = loadavg();
const inspector = new Session();
let allocatedBytes: number | undefined;
let cpuUs: number | undefined;
let elapsedMs: number | undefined;
let found: number;
try {
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    found = run(iterations);
    allocatedBytes = allocated((await inspector.post("HeapProfiler.stopSampling")).profile.head);
  } else {
    const cpuBefore = process.threadCpuUsage();
    const started = performance.now();
    found = run(iterations);
    elapsedMs = performance.now() - started;
    const cpu = process.threadCpuUsage(cpuBefore);
    cpuUs = cpu.user + cpu.system;
  }
} finally {
  inspector.disconnect();
}
const memoryAfter = process.memoryUsage();
console.log(
  JSON.stringify({
    workload: "warm repository-workspace owner lookup",
    ownerSourceSha256,
    host: hostname(),
    node: process.version,
    loadBefore,
    loadAfter: loadavg(),
    rowCount,
    iterations,
    warmup: owners.length,
    resultDigest: digest.digest("hex"),
    found,
    allocationSampling: values.allocations,
    elapsedMs,
    cpuUsPerLookup: cpuUs === undefined ? undefined : cpuUs / iterations,
    allocatedBytesPerLookup: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    memoryBefore,
    memoryAfter,
  }),
);
