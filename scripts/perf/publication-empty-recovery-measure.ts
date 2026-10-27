/**
 * Empty publication recovery through the actual coordinator and placement read worker.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/publication-empty-recovery-measure.ts \
 *   --state-dir "$PWD/.local/publication-probe" --pending 10000 --iterations 2000
 * Repeat with --allocations for a separate main-thread allocation pass, and with
 * --pending 0. Alternate base/candidate order. --owner selects a historical
 * github-publication-coordinator-methods.ts copied beside its original imports.
 * The owner receives the already-proven empty startup publication snapshot. Pending
 * workspace results are real synthetic SQLite rows, read through the normal worker.
 * This measures the redundant recovery read, not Gateway admission or Git/network.
 * Fixture preparation, warmup and unchanged-state verification are outside timing.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { DB as StateDatabase } from "../../src/state/openclaw-state-db.generated.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    pending: { type: "string", default: "10000" },
    iterations: { type: "string", default: "2000" },
    warmup: { type: "string", default: "20" },
    allocations: { type: "boolean", default: false },
    owner: { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir must name a fresh synthetic directory");
assert(global.gc, "Run with --expose-gc");
const integer = (key: "pending" | "iterations" | "warmup", min: number) =>
  parseStrictIntegerOption({ raw: values[key], label: `--${key}`, min, fallback: min });
const pending = integer("pending", 0);
const iterations = integer("iterations", 1);
const warmup = integer("warmup", 0);
const stateDir = path.resolve(values["state-dir"]);
const ownerUrl = values.owner
  ? pathToFileURL(path.resolve(values.owner))
  : new URL("../../src/gateway/github-publication-coordinator-methods.ts", import.meta.url);
const ownerSourceSha256 = createHash("sha256")
  .update(await readFile(ownerUrl))
  .digest("hex");
await mkdir(stateDir, { mode: 0o700 });
const syntheticEnv = {
  PATH: process.env.PATH,
  HOME: stateDir,
  OPENCLAW_HOME: stateDir,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  TMPDIR: stateDir,
};
for (const key of Object.keys(process.env)) {
  delete process.env[key];
}
Object.assign(process.env, syntheticEnv);

const state = await import("../../src/state/openclaw-state-db.js");
const inspector = new Session();
try {
  const { withEngineStoreAdmission } =
    await import("../../src/infra/database-engine/admission-scope.js");
  const { createGitHubPublicationCoordinatorMethods } = (await import(
    ownerUrl.href
  )) as typeof import("../../src/gateway/github-publication-coordinator-methods.js");
  const { createWorkerSessionPlacementStore } =
    await import("../../src/gateway/worker-environments/placement-store.js");
  const { ensureLocal } =
    await import("../../src/gateway/worker-environments/placement-row-codec.js");
  const { executeSqliteQuerySync, getNodeSqliteKysely } =
    await import("../../src/infra/kysely-sync.js");
  const { captureOpenClawStateWorkerContext } =
    await import("../../src/state/openclaw-state-worker-context.js");
  const database = withEngineStoreAdmission(() => state.openOpenClawStateDatabase());
  withEngineStoreAdmission(() =>
    state.runOpenClawStateWriteTransaction(
      ({ db }) => {
        for (let index = 0; index < pending; index++) {
          const sessionId = `synthetic-${index}`;
          ensureLocal(
            db,
            { sessionId, sessionKey: `agent:main:${sessionId}`, agentId: "main" },
            1000,
          );
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<Pick<StateDatabase, "worker_workspace_pending_results">>(db)
              .insertInto("worker_workspace_pending_results")
              .values({
                session_id: sessionId,
                environment_id: `synthetic-environment-${index}`,
                owner_epoch: 1,
                placement_generation: 0,
                claim_id: `synthetic-claim-${index}`,
                run_id: `synthetic-run-${index}`,
                gateway_instance_id: "synthetic-previous-gateway",
                created_at_ms: 1000,
              }),
          );
        }
      },
      { database },
    ),
  );
  const placements = withEngineStoreAdmission(() =>
    createWorkerSessionPlacementStore({ database, now: () => 1000 }),
  );
  const context = captureOpenClawStateWorkerContext();
  let pendingReads = 0;
  const readPending = placements.listPendingWorkspaceResultsAsync.bind(placements);
  placements.listPendingWorkspaceResultsAsync = (...args) => {
    pendingReads++;
    return readPending(...args);
  };
  const unexpected = (): never => {
    throw new Error("Empty publication recovery attempted a publication effect");
  };
  const coordinator = createGitHubPublicationCoordinatorMethods({
    placements,
    assertCurrent: () => context.admission.assertCurrent(),
    requestForClaimV2: unexpected,
    getCommittedRuntimeConfig: () => ({}),
    signal: new AbortController().signal,
    sameWorktree: unexpected,
    processRow: unexpected,
    recordRequestingRun: unexpected,
  });
  const before = await readPending();
  assert.equal(before.length, pending);
  const run = async (count: number) => {
    for (let index = 0; index < count; index++) {
      await coordinator.resumeSessionRequests(undefined, () => true);
    }
  };
  await run(warmup);
  global.gc();
  await nextTurn();
  pendingReads = 0;
  const loadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const mainBefore = process.threadCpuUsage();
  const processBefore = process.cpuUsage();
  const started = performance.now();
  await run(iterations);
  const elapsedMs = performance.now() - started;
  const mainCpu = process.threadCpuUsage(mainBefore);
  const processCpu = process.cpuUsage(processBefore);
  const memoryAfter = process.memoryUsage();
  const measuredReads = pendingReads;
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
  assert.deepEqual(await readPending(), before);
  console.log(
    JSON.stringify({
      workload: "empty publication recovery; real pending-workspace read worker",
      ownerSourceSha256,
      pending,
      iterations,
      warmup,
      allocationSampling: values.allocations,
      pendingReads: measuredReads,
      unchangedPendingResults: true,
      elapsedMs,
      mainThreadCpuUsPerOperation: (mainCpu.user + mainCpu.system) / iterations,
      processCpuUsPerOperation: (processCpu.user + processCpu.system) / iterations,
      mainThreadAllocatedBytesPerOperation: profile
        ? allocated(profile.head) / iterations
        : undefined,
      loadBefore,
      loadAfter: loadavg(),
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  inspector.disconnect();
  await state.closeOpenClawStateDatabaseAsync();
  await rm(stateDir, { recursive: true });
}
