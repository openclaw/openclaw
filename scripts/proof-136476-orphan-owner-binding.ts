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
 *  - `persistSubagentRunsToDisk` / `loadSubagentRegistryFromSqlite` — the real
 *    SQLite state store, in a temp `OPENCLAW_STATE_DIR`. Final effects are read
 *    back from the database file, not from memory.
 *  - `recordGatewayBootStart` / `readGatewayBootLifecycleSegments` — the real
 *    boot-lifecycle tables that drive crash attribution.
 *
 * Stubbed, and only at the transport edge: the announce flow, the completion
 * reply capture, the gateway call, the requester settle wake, the browser
 * cleanup and the detached-task lookup. Each is a recorder, so "was the
 * requester notified" and "did cleanup dispatch" are observable facts rather
 * than assumptions. Everything between the helper and those edges is real.
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
const { persistSubagentRunsToDisk, persistSubagentRunsToDiskOrThrow } =
  await import("../src/agents/subagents/registry/subagent-registry-state.js");
const { loadSubagentRegistryFromSqlite } =
  await import("../src/agents/subagents/registry/subagent-registry.store.sqlite.js");
const { loadGatewayBootSegmentsForAttribution } =
  await import("../src/agents/subagents/registry/subagent-orphan-attribution.js");

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
  const resumedRuns = new Set<string>();
  const persist = (...runIds: string[]) => {
    persistSubagentRunsToDisk(runs, runIds.length > 0 ? runIds : undefined);
  };
  const persistOrThrow = (...runIds: string[]) => {
    persistSubagentRunsToDiskOrThrow(runs, runIds.length > 0 ? runIds : undefined);
  };
  // Mirrors the production wiring in src/agents/subagents/registry/subagent-registry.ts.
  const controller = new SubagentLifecycleController({
    runs,
    resumedRuns,
    subagentAnnounceTimeoutMs: 60_000,
    getRuntimeConfig: () => ({}) as never,
    persist,
    persistOrThrow,
    clearPendingLifecycleError: () => {},
    countPendingDescendantRuns: () => 0,
    suppressAnnounceForSteerRestart: () => false,
    // No detached task backs these runs; the real "unavailable" resolution is
    // what the production lookup returns for an un-tasked run.
    resolveSubagentTask: () => ({ lookup: "unavailable" }) as never,
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

async function runScenario(ownership: "current" | "replaced" | "released"): Promise<void> {
  console.log(`\n== scenario: ${ownership} ==`);
  const now = Date.now();
  const deadBootStartedAt = now - 3_600_000;
  const runStartedAt = deadBootStartedAt + 60_000;
  const lastActivityAt = runStartedAt + 120_000;
  const liveBootStartedAt = now - 60_000;

  const deadBootId = insertCrashedPredecessorBoot(deadBootStartedAt);
  const liveBootId = recordGatewayBootStart(process.env, liveBootStartedAt, "proof-136476-live");
  check("live boot recorded by the production writer", typeof liveBootId === "string");

  const segments = readGatewayBootLifecycleSegments({ sinceMs: deadBootStartedAt - 1_000 });
  check(
    "boot history holds the crashed predecessor and the live successor",
    segments.some(
      (s) => s.bootId === deadBootId && s.completedAtMs === null && s.outcome === null,
    ) && segments.some((s) => s.bootId === liveBootId && s.pid === process.pid),
    { segments: segments.length },
  );
  // The attribution loader caches; force this scenario's rows to be read.
  loadGatewayBootSegmentsForAttribution(now, { forceRefresh: true });

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
  persistSubagentRunsToDisk(runs);
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
    runs,
    resumedRuns: new Set<string>(),
    storeCache: new Map(),
    completeSubagentRunWithRecovery: runtime.completeSubagentRunWithRecovery,
  });

  await queued;
  if (ownership === "replaced" && successor) {
    runs.set(runId, successor);
    persistSubagentRunsToDisk(runs, [runId]);
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
  const settleDeadline = Date.now() + 5_000;
  while (Date.now() < settleDeadline) {
    if (ownership === "current" && typeof entry.cleanupCompletedAt === "number") {
      break;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  const durable = readDurableRun(runId);
  if (ownership === "current") {
    check("in-memory row went terminal", entry.execution.status === "terminal", {
      status: entry.execution.status,
    });
    check(
      "recorded error is the crash attribution, not the generic lost-context text",
      typeof entry.execution.outcome?.error === "string" &&
        entry.execution.outcome.error.includes("ended without a clean stop"),
      { error: entry.execution.outcome?.error },
    );
    check(
      "attribution reports recorded-output PRESENCE, never a message count",
      typeof entry.execution.outcome?.error === "string" &&
        entry.execution.outcome.error.includes("no output recorded in the run registry") &&
        !/assistant messages? recorded/.test(entry.execution.outcome.error),
      { error: entry.execution.outcome?.error },
    );
    check(
      "restart interval is described from last recorded activity, not as asserted downtime",
      typeof entry.execution.outcome?.error === "string" &&
        entry.execution.outcome.error.includes("after the run's last recorded activity") &&
        !entry.execution.outcome.error.includes("gateway absent"),
      { error: entry.execution.outcome?.error },
    );
    check("durable SQLite row is terminal", durable?.execution.status === "terminal", {
      status: durable?.execution.status,
    });
    check(
      "durable SQLite row carries the attributed error",
      typeof durable?.execution.outcome?.error === "string" &&
        durable.execution.outcome.error === entry.execution.outcome?.error,
    );
    check("requester was notified exactly once", edges.announce === 1, edges);
    check("cleanup dispatched", typeof entry.cleanupCompletedAt === "number", {
      cleanupCompletedAt: entry.cleanupCompletedAt,
    });
    console.log(`  attributed error: ${entry.execution.outcome?.error}`);
  } else {
    const label = ownership === "replaced" ? "successor" : "released";
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
    } else {
      check(
        "released: durable row was never written to a terminal state",
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
        "released: durable row is byte-identical to its pre-recovery snapshot",
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

try {
  console.log(`proof-136476 orphan owner binding :: state dir ${stateDir}`);
  await runScenario("current");
  await runScenario("replaced");
  await runScenario("released");
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
