/**
 * Session identity deletion wakes through the real Gateway placement runtime owner.
 * Run the same script with each owner revision, alternating base/candidate order:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/placement-identity-recovery-bench.ts \
 *   --state-dir "$PWD/.local/recovery-base" \
 *   --retained 10000 --active 16 --iterations 3200 --warmup 128
 * Repeat separately with --allocations; sampled timings are not CPU evidence.
 * --owner may select a historical startup module copied beside the original so
 * its relative imports keep resolving against the same dependency revision.
 * Each iteration emits one unrelated deletion, waits for retirement and any recovery,
 * then yields. Provider inspection is synthetic; placement and session reads are real.
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
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { WorkerEnvironmentRecord } from "../../src/gateway/worker-environments/environment-record.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    retained: { type: "string", default: "10000" },
    active: { type: "string", default: "16" },
    iterations: { type: "string", default: "3200" },
    warmup: { type: "string", default: "128" },
    allocations: { type: "boolean", default: false },
    owner: { type: "string" },
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
assert(active <= retained);
const stateDir = path.resolve(values["state-dir"]);
const ownerUrl = values.owner
  ? pathToFileURL(path.resolve(values.owner))
  : new URL("../../src/gateway/server-worker-placement-startup.ts", import.meta.url);
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
let stopRuntime: (() => Promise<void>) | undefined;
try {
  const { createGatewayWorkerPlacementRuntime, createGatewayGitHubPublicationRuntime } =
    (await import(
      ownerUrl.href
    )) as typeof import("../../src/gateway/server-worker-placement-startup.js");
  const { createWorkerEnvironmentService } =
    await import("../../src/gateway/worker-environments/service.js");
  const { createWorkerEnvironmentStore } =
    await import("../../src/gateway/worker-environments/store.js");
  const { borrowOpenClawAgentDatabase } = await import("../../src/state/openclaw-agent-db.js");
  const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
  const { createGatewaySchedulerClock, createTestGatewayScheduler } =
    await import("../../src/test-utils/gateway-scheduler-clock.js");
  const { emitSessionIdentityMutation } =
    await import("../../src/sessions/session-lifecycle-events.js");
  const { createWorkerSessionPlacementStore } =
    await import("../../src/gateway/worker-environments/placement-store.js");
  const { advancePlacementFixtureToActive, writePlacementEnvironmentFixture } =
    await import("../../src/gateway/worker-environments/placement-test-fixtures.js");
  const { ensureLocal, query } =
    await import("../../src/gateway/worker-environments/placement-row-codec.js");
  const { executeSqliteQuerySync } = await import("../../src/infra/kysely-sync.js");
  const { WORKER_PROTOCOL_FEATURES } =
    await import("../../packages/gateway-protocol/src/schema/worker-admission.js");
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
  for (let index = 0; index < active; index++) {
    const session = identity(index);
    const environmentId = `synthetic-environment-${index}`;
    const environment: WorkerEnvironmentRecord = {
      environmentId,
      providerId: "device",
      profileId: "synthetic",
      profileSnapshot: { settings: {}, executionMode: "remote-exec" },
      preparation: null,
      provisionOperationId: `synthetic-provision-${index}`,
      nodeSetupId: null,
      nodeDeviceId: `synthetic-device-${index}`,
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
  // Seed the matching durable session identities before runtime readers are admitted.
  const agent = borrowOpenClawAgentDatabase({ agentId: "main" });
  try {
    agent.db.exec("BEGIN");
    const session = agent.db.prepare(
      "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, 1000, 1000)",
    );
    const entry = agent.db.prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at, status) VALUES (?, ?, ?, 1, 1000, 'done')",
    );
    for (let index = 0; index < retained; index++) {
      const current = identity(index);
      entry.run(
        current.sessionKey,
        current.sessionId,
        JSON.stringify({
          sessionId: current.sessionId,
          updatedAt: 1000,
          status: "done",
        }),
      );
      session.run(current.sessionId, current.sessionKey);
    }
    agent.db.exec("COMMIT");
  } finally {
    agent.release();
  }
  const config = {};
  setRuntimeConfigSnapshot(config);
  const time = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(time.clock);
  const environmentStore = await createWorkerEnvironmentStore({ database, now: () => 1000 });
  const environmentService = createWorkerEnvironmentService({
    scheduler,
    store: environmentStore,
    getConfig: () => config,
    resolveProvider: (id) =>
      id === "device"
        ? {
            id: "device",
            requiresNodeEnrollment: true,
            supportedExecutionModes: ["remote-exec"],
            resolveAllocation: unexpected,
            provision: unexpected,
            inspect: async () => ({ status: "active" }),
            destroy: unexpected,
          }
        : undefined,
    prepareInstallation: unexpected,
    bootstrapWorker: unexpected,
    now: () => 1000,
  });
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  const publications = createGatewayGitHubPublicationRuntime({
    placements,
    getCommittedRuntimeConfig: () => config,
    warn,
  });
  let publicationSettled = Promise.withResolvers<void>();
  const reconcilePublications = publications.reconcilePublications;
  publications.reconcilePublications = async (...args) => {
    await reconcilePublications(...args);
    publicationSettled.resolve();
  };
  const runtime = createGatewayWorkerPlacementRuntime({
    scheduler,
    placements,
    initialPlacements: [],
    environments: environmentService,
    getCommittedRuntimeConfig: () => config,
    githubPublicationRuntime: publications,
    gatewayNamespace: "synthetic-recovery-benchmark",
    cancelSessionWork: async () => {},
    revokeSessionAuthority: () => {},
    warn,
  });
  let sweeps = 0;
  const reconcileActive = runtime.dispatchService.reconcileActive;
  runtime.dispatchService.reconcileActive = (...args) => {
    sweeps++;
    return reconcileActive(...args);
  };
  const sidecar = await runtime.startRuntime({
    isClosePreludeStarted: () => false,
    registerSidecar: () => {},
    unregisterSidecar: () => {},
  });
  assert(sidecar);
  stopRuntime = sidecar.stop;
  await publicationSettled.promise;
  await nextTurn();
  assert.deepEqual(warnings, []);
  const before = await placements.listAsync();
  assert.equal(before.length, retained);
  const activeIds = Array.from({ length: active }, (_, index) => identity(index).sessionId);
  const projectionBefore = await readProjection(activeIds, { current: true });
  assert.equal((await placements.readRecoveryCandidates()).length, active);
  const databaseIdentity = Symbol("synthetic-benchmark");
  let event = 0;
  const run = async (count: number) => {
    for (let index = 0; index < count; index++) {
      publicationSettled = Promise.withResolvers<void>();
      emitSessionIdentityMutation({
        kind: "delete",
        agentId: "main",
        databaseIdentity,
        previous: { sessionId: `deleted-${event++}`, sessionKeys: ["agent:main:deleted"] },
      });
      await publicationSettled.promise;
      // Release the runtime's tracked operation before publishing the next event.
      await nextTurn();
    }
  };
  await run(warmup);
  global.gc();
  await nextTurn();
  projectionReads = 0;
  sweeps = 0;
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
  assert.deepEqual(warnings, []);
  assert.deepEqual(await placements.listAsync(), before);
  assert.deepEqual(await readProjection(activeIds, { current: true }), projectionBefore);
  console.log(
    JSON.stringify({
      workload:
        "unrelated session identity deletions; real runtime subscription and persisted reads; no Gateway RPC",
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
      recoverySweeps: sweeps,
      modeledRecoveriesPerMinuteAtSixEvents: (measuredReads / iterations) * 6 + active,
      readsPerNotification: measuredReads / iterations,
      readsPerMinute: (measuredReads * 60_000) / elapsedMs,
      elapsedMs,
      mainThreadCpuMs: (mainCpu.user + mainCpu.system) / 1000,
      mainThreadCpuUsPerNotification: (mainCpu.user + mainCpu.system) / iterations,
      processCpuMs: (processCpu.user + processCpu.system) / 1000,
      processCpuUsPerNotification: (processCpu.user + processCpu.system) / iterations,
      mainThreadAllocatedBytes: allocatedBytes,
      mainThreadAllocatedBytesPerNotification:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      loadBefore,
      loadAfter: loadavg(),
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  inspector.disconnect();
  await stopRuntime?.();
  const { closeOpenClawAgentDatabasesAsync } =
    await import("../../src/state/openclaw-agent-db-lifecycle.js");
  await closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
  await rm(stateDir, { recursive: true });
}
