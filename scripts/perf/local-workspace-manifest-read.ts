/**
 * Saved workspace manifest read + worker handoff, using synthetic directory packs.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/local-workspace-manifest-read.ts \
 *   [files=80000] [iterations=10] [timing|allocation] [database=:memory:]
 * Optional database must be a new task-owned file; :memory: excludes filesystem IO.
 * Append --target-bytes=11780000000 to seed distinct saved trees sequentially until
 * the database reaches that size. No padding, copied databases or schema changes.
 * Append --reuse to open an existing fixture read-only for subsequent A/B runs;
 * all arms must use the same files argument and schema-compatible source revisions.
 * OPENCLAW_BENCH_BASELINE_DIR selects a sparse original-source overlay before imports.
 * Run five alternating baseline/candidate pairs with identical arguments. Fixture,
 * warmup and forced GC are excluded. Timing is untraced; allocation is a separate
 * 32 KiB sampled pass including collected objects. Both report CPU/work, read and
 * total latency, GC by kind, RSS/heap endpoints, host load and checked output digest.
 * Accept identical materialized output and less CPU/allocation without adverse
 * controlled timing. This measures the real snapshot/codec/materialization owners
 * in one process, not worker scheduling or whole-Gateway latency. It creates 10k
 * projection rows and one large manifest, or enough distinct manifests for the
 * requested disk size. Only the fixed first manifest is measured in either case.
 * --sweep measures the production GC handler across every saved tree instead.
 * Sweep acceptance: identical candidates, checkpoint read holds reduced by >=90%,
 * and no >20% regression in paired wall/CPU/allocation medians. Run two parent A/A
 * controls and five interleaved pairs. This does not claim lower total disk IO.
 * --sweep-epoch=4 selects its epoch (default 3). Nonempty candidate sets are
 * reported as sorted digests; compare these between source revisions too.
 * For historical fixtures, use stored epochs >=2: SQLite encodes 0 and 1 without
 * payload bytes, which understates the cost of reading an epoch after a large pack.
 * --pager-extension=<path> loads the synthetic CACHE_MISS probe for a separate
 * sweep pager pass; logical pager bytes are not physical disk bytes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { deserialize, GCProfiler, serialize } from "node:v8";
import { inflateRawSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { LocalWorkspacePreparation } from "../../src/gateway/worker-environments/local-workspace-cas.js";
import type { DB } from "../../src/state/openclaw-state-db.generated.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";

const files = Number(process.argv[2] ?? 80_000);
const iterations = Number(process.argv[3] ?? 10);
const mode = process.argv[4] ?? "timing";
const databasePath = process.argv[5] ?? ":memory:";
const options = process.argv.slice(6);
assert.ok(
  options.every(
    (option) =>
      option === "--reuse" ||
      option === "--sweep" ||
      option.startsWith("--sweep-epoch=") ||
      option.startsWith("--target-bytes=") ||
      option.startsWith("--pager-extension="),
  ),
);
const reuse = options.includes("--reuse");
const sweepEpoch = Number(
  options.find((option) => option.startsWith("--sweep-epoch="))?.split("=")[1] ?? 3,
);
assert.ok(Number.isSafeInteger(sweepEpoch) && sweepEpoch > 0);
const targetBytes = Number(
  options.find((option) => option.startsWith("--target-bytes="))?.split("=")[1] ?? 0,
);
assert.ok(Number.isSafeInteger(files) && files > 0);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
assert.ok(mode === "timing" || mode === "allocation");
assert.ok(global.gc, "requires --expose-gc");
assert.ok(Number.isSafeInteger(targetBytes) && targetBytes >= 0);
assert.ok((!reuse && targetBytes === 0) || databasePath !== ":memory:", "disk fixture required");
assert.ok(
  reuse || databasePath === ":memory:" || !existsSync(databasePath),
  "database must be new",
);
assert.ok(!reuse || existsSync(databasePath), "reuse requires an existing fixture");
if (process.env.OPENCLAW_BENCH_BASELINE_DIR) {
  await import("./worker-retained-heap-preload.js");
}
const { createLocalWorkspaceManifestTree, localWorkspaceManifestRootReference } =
  await import("../../src/gateway/worker-environments/local-workspace-manifest-tree.js");
const { localWorkspaceDigestBytes, prepareLocalWorkspaceTreePacks } =
  await import("../../src/gateway/worker-environments/local-workspace-cas.js");
const { beginLocalWorkspaceSweepInDatabase, prepareLocalWorkspaceContentInDatabase } =
  await import("../../src/gateway/worker-environments/local-workspace-cas.kernel.js");
const { localWorkspaceReadOperations, mutateLocalWorkspaceProjection } =
  await import("../../src/gateway/worker-environments/local-workspace-store.kernel.js");
const { readLocalWorkspaceManifestRows, executeLocalWorkspaceManifestRead } =
  await import("../../src/gateway/worker-environments/local-workspace-manifest-scan.js");
const { parseWorkerWorkspaceManifest } =
  await import("../../src/gateway/worker-environments/workspace-manifest.js");
const { runSqliteImmediateTransactionSync } = await import("../../src/infra/sqlite-transaction.js");
const { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } =
  await import("../../src/infra/kysely-sync.js");

const pagerExtension = options.find((option) => option.startsWith("--pager-extension="))?.slice(18);
using db = new DatabaseSync(databasePath, {
  readOnly: reuse,
  allowExtension: Boolean(pagerExtension),
});
if (pagerExtension) {
  db.loadExtension(pagerExtension);
}
const id = "synthetic-manifest";
const baseCommit = "a".repeat(40);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const filename = (index: number) =>
  `package-${String(Math.floor(index / 100)).padStart(4, "0")}/file-${String(index).padStart(6, "0")}.ts`;
function prepare(treeIndex: number) {
  const records = createLocalWorkspaceManifestTree([
    ...Array.from({ length: Math.ceil(files / 100) }, (_, index) => ({
      path: `package-${String(index).padStart(4, "0")}`,
      type: "directory" as const,
    })),
    ...Array.from({ length: files }, (_, index) => ({
      path: filename(index),
      type: "file" as const,
      mode: 0o644,
      size: 128,
      sha256: digest(`synthetic file ${index}${treeIndex === 0 ? "" : ` revision ${treeIndex}`}`),
    })),
  ]);
  const treeRoot = localWorkspaceDigestBytes(records.get("")!.treeRef);
  const baselineRef = localWorkspaceManifestRootReference(records, baseCommit);
  if (treeIndex === 0) {
    runSqliteImmediateTransactionSync(db, () => {
      for (let index = 0; index < 10_000; index++) {
        const worktreeId = index === 0 ? id : `${id}-${index}`;
        mutateLocalWorkspaceProjection(db, worktreeId, {
          kind: "create",
          row: {
            worktree_id: worktreeId,
            agent_id: "main",
            session_key: `agent:main:${worktreeId}`,
            session_id: worktreeId,
            lifecycle_revision: null,
            projection_path: `/synthetic/${worktreeId}`,
            base_commit: baseCommit,
            source_paths_json: "[]",
            baseline_json: null,
            baseline_ref: index === 0 ? baselineRef : null,
            tree_root_digest: index === 0 ? treeRoot : null,
            source_paths_digest: null,
            canonical_fingerprints: null,
            projection_fingerprints: null,
            checkpoint_json: null,
            pending_ref: null,
            pending_target: null,
            journal_json: null,
            journal_pack: null,
            paused_runtimes_json: null,
            created_at_ms: 1,
          },
        });
      }
    });
  }
  for (const batch of prepareLocalWorkspaceTreePacks(records)) {
    // The production owner emits these serialized preparation batches.
    const preparation = deserialize(inflateRawSync(batch)) as LocalWorkspacePreparation;
    runSqliteImmediateTransactionSync(db, () => {
      prepareLocalWorkspaceContentInDatabase(db, preparation);
    });
  }
  if (treeIndex !== 0) {
    runSqliteImmediateTransactionSync(db, () => {
      mutateLocalWorkspaceProjection(db, `${id}-${treeIndex}`, {
        kind: "update",
        revision: 0,
        patch: { baseline_ref: baselineRef, tree_root_digest: treeRoot },
      });
    });
  }
}
const databaseBytes = () => (databasePath === ":memory:" ? null : statSync(databasePath).size);
if (!reuse) {
  if (options.includes("--sweep")) {
    const { extractSqliteTableSchema } = await import("../../src/infra/sqlite-schema-sql.js");
    const { OPENCLAW_STATE_SCHEMA_SQL } = await import("../../src/state/openclaw-state-schema.js");
    db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "config_machine_state"));
    beginLocalWorkspaceSweepInDatabase(db);
    beginLocalWorkspaceSweepInDatabase(db);
  }
  const prepareStart = performance.now();
  let preparedTrees = 0;
  do {
    assert.ok(preparedTrees < 10_000, "target exceeds the fixture projection inventory");
    prepare(preparedTrees++);
    if (targetBytes > 0 && (preparedTrees === 1 || preparedTrees % 10 === 0)) {
      console.error(
        JSON.stringify({
          phase: "prepare",
          preparedTrees,
          databaseBytes: databaseBytes(),
          elapsedMs: performance.now() - prepareStart,
        }),
      );
    }
  } while ((databaseBytes() ?? 0) < targetBytes);
}
assert.ok((databaseBytes() ?? 0) >= targetBytes, "fixture is smaller than requested target");
const query = getNodeSqliteKysely<DB>(db);
const projectionCount = executeSqliteQueryTakeFirstSync(
  db,
  query
    .selectFrom("local_workspace_projections")
    .select((eb) => eb.fn.countAll<number>().as("count")),
)?.count;
assert.equal(projectionCount, 10_000);
const treeCount = executeSqliteQueryTakeFirstSync(
  db,
  query
    .selectFrom("local_workspace_projections")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("tree_root_digest", "is not", null),
)?.count;
if (options.includes("--sweep")) {
  db.exec("PRAGMA mmap_size=0; PRAGMA cache_size=-2048");
  const pager = pagerExtension ? db.prepare("SELECT openclaw_pager_misses() AS misses") : undefined;
  const pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
  const inspector = new Session();
  const samples = [];
  let expectedCandidates: string | undefined;
  let maxReadHoldMs = 0;
  let maxRows = 0;
  let readStatements = 0;
  let transactionStarted = 0;
  const originalExec = db.exec.bind(db);
  db.exec = (sql) => {
    const wasInTransaction = db.isTransaction;
    const started = performance.now();
    originalExec(sql);
    if (!wasInTransaction && db.isTransaction) {
      transactionStarted = started;
    } else if (wasInTransaction && !db.isTransaction) {
      maxReadHoldMs = Math.max(maxReadHoldMs, performance.now() - transactionStarted);
    }
  };
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (/^select\b/i.test(sql)) {
      statement.all = new Proxy(statement.all.bind(statement), {
        apply(all, _receiver, args) {
          const started = performance.now();
          const rows = all(...args);
          maxReadHoldMs = Math.max(maxReadHoldMs, performance.now() - started);
          maxRows = Math.max(maxRows, rows.length);
          readStatements++;
          return rows;
        },
      });
    }
    return statement;
  };
  const sweep = () =>
    localWorkspaceReadOperations["localWorkspace.sweepCandidates"]({ epoch: sweepEpoch }, db)
      .candidates;
  const warmupStarted = performance.now();
  sweep();
  const warmupMs = performance.now() - warmupStarted;
  for (let sample = 0; sample < iterations; sample++) {
    global.gc();
    if (mode === "allocation") {
      await startCollectedHeapSampling(inspector, 32_768);
    }
    maxReadHoldMs = 0;
    maxRows = 0;
    readStatements = 0;
    const readBefore = Number(pager?.get()?.misses ?? 0);
    const cpu = process.cpuUsage();
    const started = performance.now();
    const candidates = sweep();
    const elapsedMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    const allocation =
      mode === "allocation"
        ? (await inspector.post("HeapProfiler.stopSampling")).profile
        : undefined;
    if (mode === "allocation") {
      inspector.disconnect();
    }
    const candidateDigest = digest(
      JSON.stringify({
        packs: candidates.packs.map((value) => Buffer.from(value).toString("hex")).toSorted(),
        paths: candidates.paths.map((value) => Buffer.from(value).toString("hex")).toSorted(),
      }),
    );
    expectedCandidates ??= candidateDigest;
    assert.equal(candidateDigest, expectedCandidates);
    samples.push({
      elapsedMs,
      maxReadHoldMs,
      maxRows,
      readStatements,
      cpuMs: (used.user + used.system) / 1000,
      logicalReadBytes: pager ? (Number(pager.get()!.misses) - readBefore) * pageSize : undefined,
      allocatedBytes: allocation?.samples.reduce((sum, entry) => sum + entry.size, 0),
      candidateDigest,
      candidateCounts: { packs: candidates.packs.length, paths: candidates.paths.length },
      hostLoad: os.loadavg(),
      memory: process.memoryUsage(),
    });
  }
  console.log(
    JSON.stringify({
      operation: "sweepCandidates",
      databaseBytes: databaseBytes(),
      treeCount,
      sweepEpoch,
      warmupMs,
      mode,
      samples,
    }),
  );
  db.close();
  process.exit(0);
}
const action = { kind: "materialize" as const };
async function run() {
  const started = performance.now();
  const snapshot = readLocalWorkspaceManifestRows(db, { id, revision: 0, action });
  const readMs = performance.now() - started;
  const wire = zstdCompressSync(serialize([snapshot, action]));
  // Mirror the production codec at the trusted worker-to-worker boundary.
  const args = deserialize(zstdDecompressSync(wire)) as Parameters<
    typeof executeLocalWorkspaceManifestRead
  >;
  const result = await executeLocalWorkspaceManifestRead(...args);
  assert.equal(result.kind, "materialize");
  assert.ok(result.kind === "materialize");
  return { readMs, elapsedMs: performance.now() - started, wireBytes: wire.byteLength, result };
}
let expectedDigest: string;
{
  const warm = await run();
  expectedDigest = digest(warm.result.rawManifest);
  const manifest = parseWorkerWorkspaceManifest(warm.result.rawManifest, warm.result.manifestRef);
  assert.equal(manifest.entries.length, files);
  assert.equal(manifest.directories?.length, Math.ceil(files / 100));
  for (const [index, entry] of manifest.entries.entries()) {
    assert.equal(entry.path, filename(index));
    assert.ok(entry.type === "file");
    assert.equal(entry.sha256, digest(`synthetic file ${index}`));
  }
  assert.equal(warm.result.manifestRef, `sha256:${expectedDigest}`);
}
await run();
global.gc();
const inspector = new Session();
if (mode === "allocation") {
  await startCollectedHeapSampling(inspector, 32_768);
}
const gc = new GCProfiler();
const initialMemory = process.memoryUsage();
const hostLoad = os.loadavg();
const cpuStart = process.cpuUsage();
gc.start();
const started = performance.now();
const readMs: number[] = [];
const latencyMs: number[] = [];
let wireBytes = 0;
for (let index = 0; index < iterations; index++) {
  const measured = await run();
  readMs.push(measured.readMs);
  latencyMs.push(measured.elapsedMs);
  wireBytes = measured.wireBytes;
  assert.equal(measured.result.manifestRef, `sha256:${expectedDigest}`);
}
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(cpuStart);
const collections = gc.stop()?.statistics ?? [];
const memory = process.memoryUsage();
const allocation =
  mode === "allocation" ? (await inspector.post("HeapProfiler.stopSampling")).profile : undefined;
if (mode === "allocation") {
  inspector.disconnect();
}
global.gc();
function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? 0,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
  };
}
console.log(
  JSON.stringify({
    node: process.version,
    files,
    projections: 10_000,
    iterations,
    mode,
    databasePath,
    databaseBytes: databaseBytes(),
    treeCount,
    reuse,
    hostLoad,
    finalHostLoad: os.loadavg(),
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    allocatedBytes: allocation?.samples.reduce((sum, sample) => sum + sample.size, 0),
    read: distribution(readMs),
    latency: distribution(latencyMs),
    gc: distribution(collections.map((entry) => entry.cost / 1000)),
    gcByKind: Object.fromEntries(
      [...new Set(collections.map((entry) => entry.gcType))].map((kind) => [
        kind,
        distribution(
          collections.filter((entry) => entry.gcType === kind).map((entry) => entry.cost / 1000),
        ),
      ]),
    ),
    initialMemory,
    memory,
    retainedMemory: process.memoryUsage(),
    wireBytes,
    outputDigest: expectedDigest,
  }),
);
