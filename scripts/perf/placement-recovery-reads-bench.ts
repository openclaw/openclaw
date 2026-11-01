/**
 * Real placement recovery and shared-state worker reads; synthetic remote-exec owners.
 * Run the same script with each owner revision, alternating base/candidate order:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/placement-recovery-reads-bench.ts \
 *   --state-dir "$PWD/.local/recovery-base" \
 *   --retained 10000 --active 16 --iterations 3200 --warmup 128
 * Repeat separately with --allocations; sampled timings are not CPU evidence.
 * Each iteration is one session recovery inside a real reconcileActive sweep.
 * Fixture creation and unchanged-state checks are outside measurement. Main-thread
 * allocation is sampled including collected objects; process CPU includes workers.
 * No Gateway RPC, model, provider network, or remote worker runs. The freshly created
 * state directory is removed after all database readers close, including on failure.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { hostname, loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { WorkerEnvironmentRecord } from "../../src/gateway/worker-environments/environment-record.js";
import type { PlacementRecoveryDeps } from "../../src/gateway/worker-environments/placement-recovery-contract.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    retained: { type: "string", default: "10000" },
    active: { type: "string", default: "16" },
    iterations: { type: "string", default: "3200" },
    warmup: { type: "string", default: "128" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "--state-dir must name a fresh synthetic state directory");
assert(global.gc, "Run with --expose-gc");
const integer = (key: "retained" | "active" | "iterations" | "warmup", min: number) =>
  parseStrictIntegerOption({ raw: values[key], label: `--${key}`, min, fallback: min });
const retained = integer("retained", 1);
const active = integer("active", 1);
const iterations = integer("iterations", 1);
const warmup = integer("warmup", 0);
assert(active <= retained && iterations % active === 0 && warmup % active === 0);
const stateDir = path.resolve(values["state-dir"]);
const ownerUrl = new URL(
  "../../src/gateway/worker-environments/placement-dispatch-recovery.ts",
  import.meta.url,
);
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
  const { createPlacementRecoveryActions } =
    await import("../../src/gateway/worker-environments/placement-dispatch-recovery.js");
  const { createWorkerSessionPlacementStore } =
    await import("../../src/gateway/worker-environments/placement-store.js");
  const { advancePlacementFixtureToActive, writePlacementEnvironmentFixture } =
    await import("../../src/gateway/worker-environments/placement-test-fixtures.js");
  const { ensureLocal, query } =
    await import("../../src/gateway/worker-environments/placement-row-codec.js");
  const { executeSqliteQuerySync } = await import("../../src/infra/kysely-sync.js");
  const { WORKER_PROTOCOL_FEATURES } =
    await import("../../packages/gateway-protocol/src/schema/worker-admission.js");
  const { createWorkerWorkspaceOperationCoordinator } =
    await import("../../src/gateway/worker-environments/workspace-operation-coordinator.js");
  const database = state.openOpenClawStateDatabase();
  const identity = (index: number) => ({
    sessionId: `synthetic-${index}`,
    sessionKey: `agent:main:synthetic-${index}`,
    agentId: "main",
  });
  // Bulk fixture preparation precedes all measured readers and owner publications.
  state.runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensureLocal(db, identity(0), 1000);
      const seed = executeSqliteQuerySync(
        db,
        query(db).selectFrom("worker_session_placements").selectAll(),
      ).rows[0];
      assert(seed);
      for (let offset = 1; offset < retained; offset += 100) {
        const rows = Array.from({ length: Math.min(100, retained - offset) }, (_, step) => ({
          ...seed,
          session_id: identity(offset + step).sessionId,
          session_key: identity(offset + step).sessionKey,
        }));
        executeSqliteQuerySync(db, query(db).insertInto("worker_session_placements").values(rows));
      }
    },
    { database },
  );
  const placements = createWorkerSessionPlacementStore({ database, now: () => 1000 });
  const environments = new Map<
    string,
    NonNullable<ReturnType<PlacementRecoveryDeps["environments"]["get"]>>
  >();
  for (let index = 0; index < active; index++) {
    const session = identity(index);
    const environmentId = `synthetic-environment-${index}`;
    const environment: WorkerEnvironmentRecord = {
      environmentId,
      providerId: "synthetic",
      profileId: "synthetic",
      profileSnapshot: { settings: {}, executionMode: "remote-exec" },
      preparation: null,
      provisionOperationId: `synthetic-provision-${index}`,
      resourceReceipt: null,
      nodeSetupId: null,
      nodeDeviceId: null,
      sharedHost: false,
      desktop: null,
      bootstrapReceipt: {
        bundleHash: "a".repeat(64),
        openclawVersion: "2026.10.25",
        protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
      },
      ownerEpoch: 7,
      teardownTerminalState: null,
      attachedSessionIds: [session.sessionId],
      lastError: null,
      createdAtMs: 1000,
      updatedAtMs: 1000,
      stateChangedAtMs: 1000,
      lastActivatedAtMs: null,
      idleSinceAtMs: null,
      destroyRequestedAtMs: null,
      state: "attached",
      leaseId: `synthetic-lease-${index}`,
      sshEndpoint: null,
    };
    environments.set(environmentId, {
      ...environment,
      desktopAvailable: false,
      desktopApps: [],
      tunnelStatus: "stopped",
    });
    writePlacementEnvironmentFixture(database, environment);
    await advancePlacementFixtureToActive(
      placements,
      database,
      { ...session, executionMode: "remote-exec" },
      { environmentId, seedEnvironment: false },
    );
  }
  const unexpected = (): never => {
    throw new Error("Healthy recovery benchmark attempted an effect");
  };
  let projectionReads = 0;
  const readProjection = placements.readProjection.bind(placements);
  placements.readProjection = (...args) => {
    projectionReads++;
    return readProjection(...args);
  };
  const deps: PlacementRecoveryDeps = {
    placements,
    environments: {
      get: (id) => environments.get(id),
      reconcileOnce: async () => {},
      reconcileEnvironment: unexpected,
      fenceWorkerTurnForRecovery: unexpected,
      supportsProviderExecutionMode: (_providerId, mode) => mode === "remote-exec",
      startTunnel: unexpected,
      stopTunnel: unexpected,
      destroy: unexpected,
      reclaim: unexpected,
    },
    failure: {
      failActive: unexpected,
      failDraining: unexpected,
      reclaimActive: unexpected,
      retryFailedTeardown: unexpected,
      teardownEnvironment: unexpected,
    },
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    resolveWorkspace: unexpected,
    withPreparedRecovery: unexpected,
    recoverPlacementMoves: async (projection) => {
      assert.equal(projection.moves.size, 0);
      return new Set<string>();
    },
  };
  const recovery = createPlacementRecoveryActions(deps, []);
  const before = await placements.listAsync();
  assert.equal(before.length, retained);
  const activeIds = Array.from({ length: active }, (_, index) => identity(index).sessionId);
  const projectionBefore = await readProjection(activeIds, { current: true });
  assert.equal((await placements.readRecoveryCandidates()).length, active);
  const run = async (count: number) => {
    for (let index = 0; index < count / active; index++) {
      await recovery.reconcileActive();
    }
  };
  await run(warmup);
  global.gc();
  await nextTurn();
  projectionReads = 0;
  const memoryBefore = process.memoryUsage();
  const loadBefore = loadavg();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const mainCpuBefore = process.threadCpuUsage();
  const processCpuBefore = process.cpuUsage();
  const started = performance.now();
  await run(iterations);
  const elapsedMs = performance.now() - started;
  const mainCpu = process.threadCpuUsage(mainCpuBefore);
  const processCpu = process.cpuUsage(processCpuBefore);
  const memoryAfter = process.memoryUsage();
  const measuredReads = projectionReads;
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
  const allocatedBytes = profile ? allocated(profile.head) : undefined;
  assert.deepEqual(await placements.listAsync(), before);
  assert.deepEqual(await readProjection(activeIds, { current: true }), projectionBefore);
  console.log(
    JSON.stringify({
      workload: "healthy remote-exec recovery; real persisted placement reads; no Gateway RPC",
      ownerSourceSha256,
      host: hostname(),
      node: process.version,
      allocationSampling: values.allocations,
      retained,
      active,
      iterations,
      warmup,
      unchangedPlacements: true,
      unchangedProjection: true,
      outputSha256: createHash("sha256").update(JSON.stringify(before)).digest("hex"),
      projectionReads: measuredReads,
      readsPerRecovery: measuredReads / iterations,
      readsPerMinute: (measuredReads * 60_000) / elapsedMs,
      elapsedMs,
      mainThreadCpuMs: (mainCpu.user + mainCpu.system) / 1000,
      mainThreadCpuUsPerRecovery: (mainCpu.user + mainCpu.system) / iterations,
      processCpuMs: (processCpu.user + processCpu.system) / 1000,
      processCpuUsPerRecovery: (processCpu.user + processCpu.system) / iterations,
      mainThreadAllocatedBytes: allocatedBytes,
      mainThreadAllocatedBytesPerRecovery:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
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
