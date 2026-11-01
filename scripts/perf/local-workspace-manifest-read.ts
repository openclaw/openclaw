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
assert.ok(options.every((option) => option === "--reuse" || option.startsWith("--target-bytes=")));
const reuse = options.includes("--reuse");
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
const { prepareLocalWorkspaceContentInDatabase } =
  await import("../../src/gateway/worker-environments/local-workspace-cas.kernel.js");
const { mutateLocalWorkspaceProjection } =
  await import("../../src/gateway/worker-environments/local-workspace-store.kernel.js");
const { readLocalWorkspaceManifestRows, executeLocalWorkspaceManifestRead } =
  await import("../../src/gateway/worker-environments/local-workspace-manifest-scan.js");
const { parseWorkerWorkspaceManifest } =
  await import("../../src/gateway/worker-environments/workspace-manifest.js");
const { runSqliteImmediateTransactionSync } = await import("../../src/infra/sqlite-transaction.js");
const { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } =
  await import("../../src/infra/kysely-sync.js");

using db = new DatabaseSync(databasePath, { readOnly: reuse });
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
