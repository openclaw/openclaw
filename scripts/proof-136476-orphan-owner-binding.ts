import { randomUUID } from "node:crypto";
/**
 * Real-runtime proof for PR #136476: crash-orphan recovery must not act on a
 * successor that took the same runId while the completion was queued.
 *
 * The reviewed positive trace shows ordinary crash recovery working. It does
 * not show the negative case, which is what this harness pins: when the
 * inspected registry row is REPLACED or RELEASED while the orphan completion
 * waits on the terminal completion lock, nothing may be persisted, nobody may
 * be notified, and no cleanup may run.
 *
 * Real (not mocked, not vitest):
 *  - `reconcileStaleActiveSubagentRun` — the orphan helper under review.
 *  - `createSubagentRegistryCompletionRuntime` — the retry/admission wrapper.
 *  - `SubagentLifecycleController` — the real terminal-completion lock, the
 *    real `expectedEntry` identity guard, and the real terminal-effect chain.
 *  - `persistRegistryFixture` / `loadSubagentRegistryFromSqlite` — the real
 *    SQLite state store, in a temp `OPENCLAW_STATE_DIR`. These seed and read
 *    the committed projection directly; every write the code under test makes
 *    goes through the real `mutateSubagentRuns` owner inside the controller.
 *    Final effects are read back from the database file, not from memory.
 *  - `recordGatewayBootStart` / `readGatewayBootLifecycleSegments` — the real
 *    boot-lifecycle tables that drive crash attribution.
 *
 * Stubbed, and only at the transport edge: the announce flow, the completion
 * reply capture, the gateway call, the requester settle wake, the browser
 * cleanup. Each is a recorder, so "was the requester notified" and "did
 * cleanup dispatch" are observable facts rather than assumptions. Everything
 * between the helper and those edges is real.
 *
 * One row is written directly: the crashed predecessor boot, because
 * `recordGatewayBootStart` can only ever record the current pid. It is inserted
 * through the same schema the Gateway writes, with a foreign pid, no completion
 * time and no outcome — the shape a process that died leaves behind.
 *
 * Scenarios:
 *  1. current   — control. The row is still the inspected one. The run must go
 *                 durably terminal with the attributed crash error, the
 *                 requester must be notified, and cleanup must dispatch.
 *  2. replaced  — a successor row takes the runId while the completion is
 *                 queued. The successor must be byte-identical afterwards in
 *                 memory AND in SQLite, with no notification and no cleanup.
 *  3. released  — the row is deleted while the completion is queued. Nothing
 *                 may be persisted or delivered.
 *  4. resumed   — the SAME row acquires a live execution context while the
 *                 completion is queued. `expectedEntry` still identifies its
 *                 owner, so only the execution-authority fence can stop the
 *                 terminal write, the notification and the cleanup.
 *  5. queued    — the SAME run is republished as queued while the completion
 *                 is queued. The republished row is the same owner, so the
 *                 controller would still admit it; nothing may be written.
 *  6. history-read race — the boot-history read now runs on the shared-state
 *                 read worker, so the sweeper yields before it has decided
 *                 anything. A successor takes the runId during that real
 *                 worker round trip. The inspected row must be abandoned
 *                 before any completion is attempted.
 *
 * Run: pnpm tsx scripts/proof-136476-orphan-owner-binding.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "proof-136476-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_DIR ??= stateDir;

const { getNodeSqliteKysely, executeSqliteQuerySync } = await import("../src/infra/kysely-sync.js");
const { runOpenClawStateWriteTransaction } = await import("../src/state/openclaw-state-db.js");
const { recordGatewayBootStart, readGatewayBootLifecycleSegments } =
  await import("../src/infra/gateway-boot-lifecycle.js");
const { SubagentLifecycleController } =
  await import("../src/agents/subagents/registry/subagent-registry-lifecycle.js");
const { createSubagentRegistryCompletionRuntime } =
  await import("../src/agents/subagents/registry/subagent-registry-completion-runtime.js");
const { reconcileStaleActiveSubagentRun } =
  await import("../src/agents/subagents/registry/subagent-registry-sweeper-orphan.js");
const { getLatestSubagentRunByChildSessionKeyFromRuns } =
  await import("../src/agents/subagents/registry/subagent-registry-queries.js");
// The registry's own committed-projection fixture writer and reader. The
// `persistSubagentRunsToDisk*` family this harness used is gone from
// `origin/main`: the lifecycle controller persists through `mutateSubagentRuns`
// now, and these are the surviving direct-to-SQLite seams.
const { loadSubagentRegistryFromSqlite, persistRegistryFixture } =
  await import("../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js");
const { loadGatewayBootSegmentsForAttribution } =
  await import("../src/agents/subagents/registry/subagent-orphan-attribution.js");
const { copySubagentRunRuntimeOwner, isSameSubagentRunOwner } =
  await import("../src/agents/subagents/registry/subagent-run-generation.js");

type SubagentRunRecord =
  import("../src/agents/subagents/registry/subagent-registry.types.js").SubagentRunRecord;

const failures: string[] = [];
let checks = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  const rendered = detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`;
  console.log(`  FAIL ${label}${rendered}`);
  failures.push(`${label}${rendered}`);
}

const HOST_BOOT_ID = "proof-136476-host-boot";
const DEAD_BOOT_PID = 999_001;

/**
 * The crashed predecessor. Written directly because the production writer can
 * only record `process.pid`; the row shape (open, no outcome) is exactly what a
 * process death leaves behind.
 */
function insertCrashedPredecessorBoot(startedAtMs: number): string {
  const bootId = randomUUID();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<{
        gateway_boot_lifecycle: {
          boot_id: string;
          pid: number;
          started_at_ms: number;
          completed_at_ms: number | null;
          outcome: string | null;
          startup_reason: string | null;
          reason: string | null;
          host_boot_id: string | null;
        };
      }>(db);
      executeSqliteQuerySync(
        db,
        kysely.insertInto("gateway_boot_lifecycle").values({
          boot_id: bootId,
          pid: DEAD_BOOT_PID,
          started_at_ms: startedAtMs,
          completed_at_ms: null,
          outcome: null,
          startup_reason: "proof-136476-crashed-predecessor",
          reason: null,
          host_boot_id: HOST_BOOT_ID,
        }),
      );
    },
    { env: process.env },
  );
  return bootId;
}

type EdgeRecorder = {
  announce: number;
  captureReply: number;
  gatewayCalls: number;
  browserCleanup: number;
  settleWake: number;
  contextEngineEnded: number;
};

function createController(runs: Map<string, SubagentRunRecord>, edges: EdgeRecorder) {
  // Resume bookkeeping is keyed by run runtime identity, not by run id.
  const resumedRuns = new Set<object>();
  // Mirrors the production wiring in src/agents/subagents/registry/subagent-registry.ts.
  const controller = new SubagentLifecycleController({
    runs,
    resumedRuns,
    subagentAnnounceTimeoutMs: 60_000,
    getRuntimeConfig: () => ({}) as never,
    clearPendingLifecycleError: () => {},
    countPendingDescendantRuns: async () => 0,
    getLatestRunForChildSession: (key, matches) =>
      getLatestSubagentRunByChildSessionKeyFromRuns(runs, key, matches) ?? null,
    suppressAnnounceForSteerRestart: () => false,
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: async () => {},
    emitSubagentProgressEndedForRun: async () => {},
    notifyContextEngineSubagentEnded: async () => {
      edges.contextEngineEnded += 1;
    },
    retireSupersededRun: async () => {},
    resumeSubagentRun: () => {},
    // Transport edge.
    callGateway: (async () => {
      edges.gatewayCalls += 1;
      return { ok: true } as never;
    }) as never,
    captureSubagentCompletionReply: (async () => {
      edges.captureReply += 1;
      return undefined as never;
    }) as never,
    cleanupBrowserSessionsForLifecycleEnd: (async () => {
      edges.browserCleanup += 1;
    }) as never,
    runSubagentAnnounceFlow: (async () => {
      edges.announce += 1;
      return { delivered: true, disposition: "delivered" } as never;
    }) as never,
    maybeWakeRequesterAfterAllChildrenSettled: (async () => {
      edges.settleWake += 1;
      return false;
    }) as never,
    warn: (message: string, meta?: Record<string, unknown>) => {
      const error = (meta as { error?: unknown } | undefined)?.error;
      console.log(`  [warn] ${message}${error instanceof Error ? `: ${error.message}` : ""}`);
    },
  });
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const runtime = createSubagentRegistryCompletionRuntime({
    runs,
    resumed: resumedRuns,
    retryTimers,
    completeSubagentRun: (params) => controller.completeSubagentRun(params),
    scheduleSweep: () => {},
    resumeRun: () => {},
    warn: (message: string, meta?: Record<string, unknown>) => {
      const error = (meta as { error?: unknown } | undefined)?.error;
      console.log(`  [warn] ${message}${error instanceof Error ? `: ${error.message}` : ""}`);
    },
  });
  return { controller, runtime, retryTimers, resumedRuns };
}

function createOrphanedRun(params: {
  runId: string;
  startedAtMs: number;
  lastActivityAtMs: number;
}): SubagentRunRecord {
  return {
    runId: params.runId,
    childSessionKey: `agent:proof:subagent:${params.runId}`,
    requesterSessionKey: "agent:proof:main",
    requesterDisplayKey: "proof",
    task: "orphan owner binding proof",
    cleanup: "keep",
    createdAt: params.startedAtMs,
    generation: 1,
    expectsCompletionMessage: true,
    execution: {
      status: "running",
      startedAt: params.startedAtMs,
      interruptedAt: params.lastActivityAtMs,
    },
    // No captured result text: this is the "died having recorded no output" case
    // the requester notification path exists for.
    completion: { required: true },
    delivery: { status: "pending" },
  };
}

function createSuccessorRun(runId: string, startedAtMs: number): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:proof:subagent:${runId}`,
    requesterSessionKey: "agent:proof:main",
    requesterDisplayKey: "proof",
    task: "successor run that took the same runId",
    cleanup: "keep",
    createdAt: startedAtMs,
    generation: 2,
    expectsCompletionMessage: true,
    execution: { status: "running", startedAt: startedAtMs },
    completion: { required: true },
    delivery: { status: "pending" },
  };
}

function readDurableRun(runId: string): SubagentRunRecord | undefined {
  return loadSubagentRegistryFromSqlite().get(runId);
}

type OrphanOwnershipScenario = "current" | "replaced" | "released" | "resumed" | "queued";

async function runScenario(ownership: OrphanOwnershipScenario): Promise<void> {
  console.log(`\n== scenario: ${ownership} ==`);
  const now = Date.now();
  const deadBootStartedAt = now - 3_600_000;
  const runStartedAt = deadBootStartedAt + 60_000;
  const lastActivityAt = runStartedAt + 120_000;
  const liveBootStartedAt = now - 60_000;

  const deadBootId = insertCrashedPredecessorBoot(deadBootStartedAt);
  const liveBootId = recordGatewayBootStart(process.env, liveBootStartedAt, "proof-136476-live");
  check("live boot recorded by the production writer", typeof liveBootId === "string");

  const segments = await readGatewayBootLifecycleSegments({ sinceMs: deadBootStartedAt - 1_000 });
  check(
    "boot history holds the crashed predecessor and the live successor",
    segments.some(
      (s) => s.bootId === deadBootId && s.completedAtMs === null && s.outcome === null,
    ) && segments.some((s) => s.bootId === liveBootId && s.pid === process.pid),
    { segments: segments.length },
  );
  // The attribution loader caches; force this scenario's rows to be read.
  await loadGatewayBootSegmentsForAttribution(now, { forceRefresh: true });

  const runId = `proof-136476-${ownership}-${randomUUID().slice(0, 8)}`;
  const entry = createOrphanedRun({
    runId,
    startedAtMs: runStartedAt,
    lastActivityAtMs: lastActivityAt,
  });
  const runs = new Map<string, SubagentRunRecord>([[runId, entry]]);
  const edges: EdgeRecorder = {
    announce: 0,
    captureReply: 0,
    gatewayCalls: 0,
    browserCleanup: 0,
    settleWake: 0,
    contextEngineEnded: 0,
  };
  const { controller, runtime, retryTimers } = createController(runs, edges);

  // Seed the durable row exactly as a crashed Gateway would have left it.
  persistRegistryFixture(runs, [runId]);
  const seeded = readDurableRun(runId);
  check(
    "stale active run is durably present before recovery",
    seeded?.execution.status === "running",
    {
      status: seeded?.execution.status,
    },
  );

  const successor = ownership === "replaced" ? createSuccessorRun(runId, now - 10_000) : undefined;
  let successorDurableBefore: SubagentRunRecord | undefined;
  // The live-execution registry the sweeper consults; membership here is what
  // "the same run came back to life" means to the orphan path.
  const liveRunContexts = new Set<string>();
  const isSelectionCurrent = () =>
    runs.get(runId) === entry &&
    typeof entry.execution.endedAt !== "number" &&
    entry.execution.status !== "queued" &&
    !liveRunContexts.has(runId);

  // Hold the real terminal completion lock so the orphan completion queues
  // behind it, then change ownership while it waits.
  const unlock = await controller.acquireTerminalCompletionLock(runId);
  let queuedResolve = () => {};
  const queued = new Promise<void>((resolve) => {
    queuedResolve = resolve;
  });
  const realAcquire = controller.acquireTerminalCompletionLock.bind(controller);
  controller.acquireTerminalCompletionLock = (id: string) => {
    const pending = realAcquire(id);
    queuedResolve();
    return pending;
  };

  const completion = reconcileStaleActiveSubagentRun({
    runId,
    entry,
    now,
    isCurrent: isSelectionCurrent,
    recoveryCurrent: {
      prepare: async () => isSelectionCurrent(),
      isHostCurrent: () => !liveRunContexts.has(runId),
    },
    completeSubagentRunWithRecovery: runtime.completeSubagentRunWithRecovery,
  });

  await queued;
  let sameOwnerQueuedDurableBefore: SubagentRunRecord | undefined;
  if (ownership === "resumed") {
    // The child was dispatched again. The row is untouched and still the
    // inspected one, so nothing but execution authority distinguishes it.
    liveRunContexts.add(runId);
  } else if (ownership === "queued") {
    const requeued = copySubagentRunRuntimeOwner(entry, {
      ...entry,
      execution: { ...entry.execution, status: "queued" as const },
    });
    runs.set(runId, requeued);
    persistRegistryFixture(runs, [runId]);
    sameOwnerQueuedDurableBefore = readDurableRun(runId);
    check(
      "requeued row is the same owner the completion would still admit",
      sameOwnerQueuedDurableBefore?.execution.status === "queued" &&
        isSameSubagentRunOwner(requeued, entry),
      { status: sameOwnerQueuedDurableBefore?.execution.status },
    );
  } else if (ownership === "replaced" && successor) {
    runs.set(runId, successor);
    persistRegistryFixture(runs, [runId]);
    successorDurableBefore = readDurableRun(runId);
    check(
      "successor is durably installed while the completion is queued",
      successorDurableBefore?.generation === 2,
      {
        generation: successorDurableBefore?.generation,
      },
    );
  } else if (ownership === "released") {
    runs.delete(runId);
  }
  unlock();
  await completion;
  // Terminal effects continue asynchronously after the completion resolves.
  // The control waits for them; the negative cases wait the same wall-clock
  // budget so "nothing happened" is a settled observation, not an early read.
  // Terminal writes publish a replacement row rather than mutating the
  // inspected one in place, so the control reads the published owner.
  const publishedRun = () => runs.get(runId);
  const settleDeadline = Date.now() + 5_000;
  while (Date.now() < settleDeadline) {
    if (ownership === "current" && typeof publishedRun()?.cleanupCompletedAt === "number") {
      break;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  const durable = readDurableRun(runId);
  if (ownership === "current") {
    const published = publishedRun();
    const publishedError = published?.execution.outcome?.error;
    check("published row went terminal", published?.execution.status === "terminal", {
      status: published?.execution.status,
    });
    check(
      "published row is still the inspected run's own owner",
      isSameSubagentRunOwner(published, entry),
    );
    check(
      "recorded error is the crash attribution, not the generic lost-context text",
      typeof publishedError === "string" && publishedError.includes("ended without a clean stop"),
      { error: publishedError },
    );
    check(
      "attribution reports recorded-output PRESENCE, never a message count",
      typeof publishedError === "string" &&
        publishedError.includes("no output recorded in the run registry") &&
        !/assistant messages? recorded/.test(publishedError),
      { error: publishedError },
    );
    check(
      "restart interval is described from last recorded activity, not as asserted downtime",
      typeof publishedError === "string" &&
        publishedError.includes("after the run's last recorded activity") &&
        !publishedError.includes("gateway absent"),
      { error: publishedError },
    );
    check("durable SQLite row is terminal", durable?.execution.status === "terminal", {
      status: durable?.execution.status,
    });
    check(
      "durable SQLite row carries the attributed error",
      typeof durable?.execution.outcome?.error === "string" &&
        durable.execution.outcome.error === publishedError,
      { durable: durable?.execution.outcome?.error, published: publishedError },
    );
    check("requester was notified exactly once", edges.announce === 1, edges);
    check("cleanup dispatched", typeof published?.cleanupCompletedAt === "number", {
      cleanupCompletedAt: published?.cleanupCompletedAt,
    });
    console.log(`  attributed error: ${publishedError}`);
  } else {
    const label = ownership === "replaced" ? "successor" : ownership;
    check(
      `${label}: inspected row was not mutated in memory`,
      entry.execution.status === "running",
      {
        status: entry.execution.status,
        outcome: entry.execution.outcome,
      },
    );
    check(`${label}: inspected row has no terminal outcome`, entry.execution.outcome === undefined);
    check(`${label}: inspected row was not cleaned up`, entry.cleanupCompletedAt === undefined);
    check(`${label}: requester was NOT notified`, edges.announce === 0, edges);
    check(`${label}: no completion reply captured`, edges.captureReply === 0, edges);
    check(`${label}: no gateway call dispatched`, edges.gatewayCalls === 0, edges);
    check(`${label}: no browser cleanup dispatched`, edges.browserCleanup === 0, edges);
    check(`${label}: no requester settle wake`, edges.settleWake === 0, edges);
    check(`${label}: no context-engine end notification`, edges.contextEngineEnded === 0, edges);
    if (ownership === "replaced" && successor) {
      check(
        "successor stayed running in memory",
        successor.execution.status === "running" && successor.execution.outcome === undefined,
        { status: successor.execution.status, outcome: successor.execution.outcome },
      );
      check("successor was not cleaned up", successor.cleanupCompletedAt === undefined);
      check("successor kept its own generation", successor.generation === 2);
      check(
        "durable SQLite successor row is unchanged and still running",
        durable?.generation === 2 &&
          durable.execution.status === "running" &&
          durable.execution.outcome === undefined &&
          durable.endedReason === undefined,
        {
          generation: durable?.generation,
          status: durable?.execution.status,
          outcome: durable?.execution.outcome,
          endedReason: durable?.endedReason,
        },
      );
      check(
        "durable successor row is byte-identical to its pre-recovery snapshot",
        JSON.stringify(durable) === JSON.stringify(successorDurableBefore),
      );
    } else if (ownership === "queued") {
      check(
        "queued: durable row stayed queued and was never written to a terminal state",
        durable?.execution.status === "queued" &&
          durable.execution.outcome === undefined &&
          durable.endedReason === undefined &&
          durable.cleanupCompletedAt === undefined,
        {
          status: durable?.execution.status,
          outcome: durable?.execution.outcome,
          endedReason: durable?.endedReason,
        },
      );
      check(
        "queued: durable row is byte-identical to its pre-recovery snapshot",
        JSON.stringify(durable) === JSON.stringify(sameOwnerQueuedDurableBefore),
      );
    } else {
      check(
        `${label}: durable row was never written to a terminal state`,
        durable?.execution.status === "running" &&
          durable.execution.outcome === undefined &&
          durable.endedReason === undefined &&
          durable.cleanupCompletedAt === undefined,
        {
          status: durable?.execution.status,
          outcome: durable?.execution.outcome,
          endedReason: durable?.endedReason,
        },
      );
      check(
        `${label}: durable row is byte-identical to its pre-recovery snapshot`,
        JSON.stringify(durable) === JSON.stringify(seeded),
      );
    }
  }

  check("no retry timer was left bound to a foreign row", retryTimers.size === 0, {
    timers: retryTimers.size,
  });
  for (const timer of retryTimers) {
    clearTimeout(timer);
  }
  controller.clearScheduledResumeTimers();
}

/**
 * Pins the post-await re-check. Attribution history is read off the gateway
 * thread, so `reconcileStaleActiveSubagentRun` suspends before it inspects the
 * run at all. This scenario makes that read a genuine read-worker round trip
 * (the cache is seeded stale, not warm) and replaces the registry row while it
 * is in flight. Nothing about the inspected row may be written afterwards.
 */
async function runHistoryReadRaceScenario(): Promise<void> {
  console.log(`\n== scenario: history-read race ==`);
  const now = Date.now();
  const deadBootStartedAt = now - 3_600_000;
  const runStartedAt = deadBootStartedAt + 60_000;

  const deadBootId = insertCrashedPredecessorBoot(deadBootStartedAt);
  check("crashed predecessor recorded for the race scenario", typeof deadBootId === "string");
  check(
    "live boot recorded by the production writer",
    typeof recordGatewayBootStart(process.env, now - 60_000, "proof-136476-race") === "string",
  );
  // Seed the cache with an expired load stamp so the helper's own call misses
  // it and performs a real read-worker round trip rather than a microtask hop.
  await loadGatewayBootSegmentsForAttribution(now - 10 * 60_000, { forceRefresh: true });

  const runId = `proof-136476-race-${randomUUID().slice(0, 8)}`;
  const entry = createOrphanedRun({
    runId,
    startedAtMs: runStartedAt,
    lastActivityAtMs: runStartedAt + 120_000,
  });
  const runs = new Map<string, SubagentRunRecord>([[runId, entry]]);
  const edges: EdgeRecorder = {
    announce: 0,
    captureReply: 0,
    gatewayCalls: 0,
    browserCleanup: 0,
    settleWake: 0,
    contextEngineEnded: 0,
  };
  const { controller, runtime, retryTimers } = createController(runs, edges);
  persistRegistryFixture(runs, [runId]);
  check(
    "stale active run is durably present before recovery",
    readDurableRun(runId)?.execution.status === "running",
  );

  const isSelectionCurrent = () =>
    runs.get(runId) === entry && typeof entry.execution.endedAt !== "number";
  const completion = reconcileStaleActiveSubagentRun({
    runId,
    entry,
    now,
    isCurrent: isSelectionCurrent,
    recoveryCurrent: {
      prepare: async () => isSelectionCurrent(),
      isHostCurrent: () => true,
    },
    completeSubagentRunWithRecovery: runtime.completeSubagentRunWithRecovery,
  });
  // No completion lock is held here: the helper has not reached completion yet.
  // It is suspended on the history read, which is the window under test.
  const successor = createSuccessorRun(runId, now - 10_000);
  runs.set(runId, successor);
  persistRegistryFixture(runs, [runId]);
  const successorDurableBefore = readDurableRun(runId);
  check(
    "successor is durably installed while the history read is in flight",
    successorDurableBefore?.generation === 2,
    { generation: successorDurableBefore?.generation },
  );
  await completion;

  const durable = readDurableRun(runId);
  check("race: inspected row was not mutated in memory", entry.execution.status === "running", {
    status: entry.execution.status,
    outcome: entry.execution.outcome,
  });
  check("race: inspected row has no terminal outcome", entry.execution.outcome === undefined);
  check("race: inspected row was not cleaned up", entry.cleanupCompletedAt === undefined);
  check("race: requester was NOT notified", edges.announce === 0, edges);
  check("race: no completion reply captured", edges.captureReply === 0, edges);
  check("race: no gateway call dispatched", edges.gatewayCalls === 0, edges);
  check("race: no browser cleanup dispatched", edges.browserCleanup === 0, edges);
  check("race: no requester settle wake", edges.settleWake === 0, edges);
  check("race: no context-engine end notification", edges.contextEngineEnded === 0, edges);
  check(
    "race: successor stayed running in memory",
    successor.execution.status === "running" && successor.execution.outcome === undefined,
    { status: successor.execution.status, outcome: successor.execution.outcome },
  );
  check(
    "race: durable successor row is byte-identical to its pre-recovery snapshot",
    JSON.stringify(durable) === JSON.stringify(successorDurableBefore),
  );
  check("race: no retry timer was left bound to a foreign row", retryTimers.size === 0, {
    timers: retryTimers.size,
  });
  for (const timer of retryTimers) {
    clearTimeout(timer);
  }
  controller.clearScheduledResumeTimers();
}

try {
  console.log(`proof-136476 orphan owner binding :: state dir ${stateDir}`);
  await runScenario("current");
  await runScenario("replaced");
  await runScenario("released");
  await runScenario("resumed");
  await runScenario("queued");
  await runHistoryReadRaceScenario();
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log(`\n${checks} assertions, ${failures.length} failed.`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`  - ${failure}`);
  }
  console.log("PROOF FAILED");
  process.exit(1);
}
console.log("All runtime assertions passed.");
process.exit(0);
