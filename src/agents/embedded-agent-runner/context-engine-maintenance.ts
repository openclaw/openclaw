/**
 * Schedules and runs deferred context-engine turn maintenance.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveContextEngineOwnerPluginId } from "../../context-engine/registry.js";
import type {
  ContextEngine,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
  ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  enqueueCommandInLane,
  GatewayDrainingError,
  isCommandLaneTaskTimeoutError,
  isGatewayDraining,
} from "../../process/command-queue.js";
import {
  completeTaskRunByRunId,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  startTaskRunByRunId,
} from "../../tasks/detached-task-runtime.js";
import {
  cancelTaskByIdForOwner,
  findTaskByRunIdForOwner,
  updateTaskNotifyPolicyForOwner,
} from "../../tasks/task-owner-access.js";
import { findActiveSessionTask } from "../session-async-task-status.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";
import {
  createDeferredTurnMaintenanceAbortSignal,
  resetDeferredTurnMaintenanceAbortStateForTest,
} from "./context-engine-maintenance-abort-signal.js";
import {
  buildTurnMaintenanceTaskDescriptor,
  markDeferredTurnMaintenanceTaskScheduleFailure,
  markDeferredTurnMaintenanceTaskTimeout,
  promoteTurnMaintenanceTaskVisibility,
  TURN_MAINTENANCE_TASK_KIND,
} from "./context-engine-maintenance-descriptor.js";
import {
  createDeferredTurnMaintenancePersistenceCheckpoint,
  type DeferredTurnMaintenanceFence,
  type DeferredTurnMaintenancePersistenceCheckpoint,
  fencedTranscriptRewriteResult,
} from "./context-engine-maintenance-fence.js";
import { log } from "./logger.js";
import {
  rewriteTranscriptEntriesInRuntimeTranscript,
  rewriteTranscriptEntriesInSessionManager,
} from "./transcript-rewrite.js";

const TURN_MAINTENANCE_LANE_PREFIX = "context-engine-turn-maintenance:";
const TURN_MAINTENANCE_LONG_WAIT_MS = 10_000;

type DeferredTurnMaintenanceScheduleParams = {
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey: string;
  sessionTarget?: ContextEngineSessionTarget;
  sessionFile: string;
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  runtimeContext?: ContextEngineRuntimeContext;
  runtimeSettings?: ContextEngineRuntimeSettings;
  agentId?: string;
  config?: OpenClawConfig;
  disposeContextEngineAfterMaintenance?: boolean;
  onScheduleFailure?: (error: unknown) => void;
};

type DeferredTurnMaintenanceRunState = {
  promise: Promise<void>;
  rerunRequested: boolean;
  latestParams: DeferredTurnMaintenanceScheduleParams;
};

const activeDeferredTurnMaintenanceRuns = new Map<string, DeferredTurnMaintenanceRunState>();

type SessionManagerRewriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;

function normalizeSessionKey(sessionKey?: string): string | undefined {
  return normalizeOptionalString(sessionKey) || undefined;
}

function resolveDeferredTurnMaintenanceLane(sessionKey: string): string {
  return `${TURN_MAINTENANCE_LANE_PREFIX}${sessionKey}`;
}

/**
 * Resolve the opt-in per-deployment bound for a single deferred (background)
 * turn-maintenance run. Absent or non-positive config means no bound, which
 * preserves the pre-change upgrade behavior of letting background maintenance
 * run unbounded. A positive value arms the lane timeout plus the fence so a
 * wedged run releases its lane and suppresses late side effects (issue #96703).
 */
function resolveDeferredTurnMaintenanceTaskTimeoutMs(config?: OpenClawConfig): number | undefined {
  const configured = config?.agents?.defaults?.compaction?.turnMaintenanceTaskTimeoutMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : undefined;
}

async function disposeDeferredMaintenanceContextEngine(
  contextEngine: ContextEngine,
): Promise<void> {
  try {
    await contextEngine.dispose?.();
  } catch (err) {
    log.warn("context engine dispose failed after deferred maintenance", {
      errorMessage: formatErrorMessage(err),
    });
  }
}

function resetDeferredTurnMaintenanceStateForTest(): void {
  activeDeferredTurnMaintenanceRuns.clear();
  resetDeferredTurnMaintenanceAbortStateForTest();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.contextEngineMaintenanceTestApi")
  ] = {
    createDeferredTurnMaintenanceAbortSignal,
    resetDeferredTurnMaintenanceStateForTest,
  };
}

export async function waitForDeferredTurnMaintenanceForSession(sessionKey?: string): Promise<void> {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedSessionKey) {
    return;
  }
  await activeDeferredTurnMaintenanceRuns.get(normalizedSessionKey)?.promise;
}

/**
 * Attach runtime-owned transcript rewrite helpers to an existing
 * context-engine runtime context payload.
 */
function buildContextEngineMaintenanceRuntimeContext(params: {
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
  sessionFile: string;
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  withSessionManagerRewriteLock?: SessionManagerRewriteLock;
  runtimeContext?: ContextEngineRuntimeContext;
  agentId?: string;
  allowDeferredCompactionExecution?: boolean;
  config?: OpenClawConfig;
  purpose?: string;
  contextEnginePluginId?: string;
  maintenanceFence?: DeferredTurnMaintenanceFence;
  persistenceCheckpoint?: DeferredTurnMaintenancePersistenceCheckpoint;
}): ContextEngineRuntimeContext {
  return {
    ...params.runtimeContext,
    ...resolveContextEngineCapabilities({
      config: params.config,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      authProfileId: normalizeOptionalString(params.runtimeContext?.authProfileId),
      contextEnginePluginId: params.contextEnginePluginId,
      purpose: params.purpose ?? "context-engine.maintenance",
    }),
    ...(params.sessionTarget ? { sessionTarget: params.sessionTarget } : {}),
    ...(params.allowDeferredCompactionExecution ? { allowDeferredCompactionExecution: true } : {}),
    rewriteTranscriptEntries: async (request) => {
      // A timed-out deferred run has already released its lane; skip the rewrite
      // so a late maintenance pass does not start mutating the transcript the
      // foreground turn is now reading.
      if (params.maintenanceFence?.tripped) {
        return fencedTranscriptRewriteResult();
      }
      if (params.sessionManager) {
        const sessionManager = params.sessionManager;
        const rewriteSessionManagerEntries = () => {
          // Re-check inside the lock: the timeout may have fired while we waited
          // to acquire it.
          if (params.maintenanceFence?.tripped) {
            return fencedTranscriptRewriteResult();
          }
          return rewriteTranscriptEntriesInSessionManager({
            sessionManager,
            replacements: request.replacements,
          });
        };
        return params.withSessionManagerRewriteLock
          ? await params.withSessionManagerRewriteLock(rewriteSessionManagerEntries)
          : rewriteSessionManagerEntries();
      }
      const rewriteRuntimeTranscriptEntries = async () => {
        if (params.maintenanceFence?.tripped) {
          return fencedTranscriptRewriteResult();
        }
        return await rewriteTranscriptEntriesInRuntimeTranscript({
          scope: {
            sessionId: params.sessionId,
            sessionKey: params.sessionKey ?? params.sessionId,
            sessionFile: params.sessionFile,
            ...(params.agentId ? { agentId: params.agentId } : {}),
          },
          request,
          config: params.config,
          // The fence can trip while the helper is blocked acquiring the write
          // lock; let it re-check and skip the persist instead of mutating the
          // transcript the resumed foreground turn now owns.
          shouldAbort: () => params.maintenanceFence?.tripped === true,
        });
      };
      // Register the persist so the timeout path can wait for a write admitted
      // before the timeout to settle before releasing the next same-session
      // read. Tracking the whole call keeps it bounded: a fenced no-op resolves
      // immediately, and only one persist is ever in flight per run.
      const persist = rewriteRuntimeTranscriptEntries();
      params.persistenceCheckpoint?.track(persist);
      return await persist;
    },
  };
}

async function executeContextEngineMaintenance(params: {
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
  sessionFile: string;
  reason: "bootstrap" | "compaction" | "turn";
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  withSessionManagerRewriteLock?: SessionManagerRewriteLock;
  runtimeContext?: ContextEngineRuntimeContext;
  runtimeSettings?: ContextEngineRuntimeSettings;
  agentId?: string;
  executionMode: "foreground" | "background";
  config?: OpenClawConfig;
  maintenanceFence?: DeferredTurnMaintenanceFence;
  persistenceCheckpoint?: DeferredTurnMaintenancePersistenceCheckpoint;
}): Promise<ContextEngineMaintenanceResult | undefined> {
  if (typeof params.contextEngine.maintain !== "function") {
    return undefined;
  }
  const result = await params.contextEngine.maintain({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: params.sessionTarget,
    sessionFile: params.sessionFile,
    runtimeSettings: params.runtimeSettings,
    runtimeContext: buildContextEngineMaintenanceRuntimeContext({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionTarget: params.sessionTarget,
      sessionFile: params.sessionFile,
      sessionManager: params.executionMode === "background" ? undefined : params.sessionManager,
      withSessionManagerRewriteLock:
        params.executionMode === "background" ? undefined : params.withSessionManagerRewriteLock,
      runtimeContext: params.runtimeContext,
      agentId: params.agentId,
      allowDeferredCompactionExecution: params.executionMode === "background",
      config: params.config,
      purpose: `context-engine.${params.reason}.maintenance`,
      contextEnginePluginId: resolveContextEngineOwnerPluginId(params.contextEngine),
      maintenanceFence: params.maintenanceFence,
      persistenceCheckpoint: params.persistenceCheckpoint,
    }),
  });
  if (result.changed) {
    log.info(
      `[context-engine] maintenance(${params.reason}) changed transcript ` +
        `rewrittenEntries=${result.rewrittenEntries} bytesFreed=${result.bytesFreed} ` +
        `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
    );
  }
  return result;
}

async function runDeferredTurnMaintenanceWorker(params: {
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey: string;
  sessionTarget?: ContextEngineSessionTarget;
  sessionFile: string;
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  runtimeContext?: ContextEngineRuntimeContext;
  runtimeSettings?: ContextEngineRuntimeSettings;
  agentId?: string;
  runId: string;
  config?: OpenClawConfig;
  disposeContextEngineAfterMaintenance?: boolean;
  maintenanceFence: DeferredTurnMaintenanceFence;
  persistenceCheckpoint: DeferredTurnMaintenancePersistenceCheckpoint;
}): Promise<void> {
  let surfacedUserNotice = false;
  let longRunningTimer: ReturnType<typeof setTimeout> | null = null;
  const shutdownAbort = createDeferredTurnMaintenanceAbortSignal();
  const surfaceMaintenanceUpdate = (summary: string, eventSummary: string) => {
    // A timed-out run was already cancelled by the scheduler; do not emit late
    // progress that would resurrect the descriptor as active.
    if (params.maintenanceFence.tripped) {
      return;
    }
    promoteTurnMaintenanceTaskVisibility({
      sessionKey: params.sessionKey,
      runId: params.runId,
      notifyPolicy: "state_changes",
    });
    surfacedUserNotice = true;
    recordTaskRunProgressByRunId({
      runId: params.runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
      lastEventAt: Date.now(),
      progressSummary: summary,
      eventSummary,
    });
  };

  try {
    const runningAt = Date.now();
    startTaskRunByRunId({
      runId: params.runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
      startedAt: runningAt,
      lastEventAt: runningAt,
      progressSummary: "Running deferred maintenance.",
      eventSummary: "Starting deferred maintenance.",
    });
    longRunningTimer = setTimeout(() => {
      try {
        surfaceMaintenanceUpdate(
          "Deferred maintenance is still running.",
          "Deferred maintenance is still running.",
        );
      } catch (error) {
        log.warn(`failed to surface deferred maintenance progress: ${String(error)}`);
      }
    }, TURN_MAINTENANCE_LONG_WAIT_MS);

    const result = await executeContextEngineMaintenance({
      contextEngine: params.contextEngine,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionTarget: params.sessionTarget,
      sessionFile: params.sessionFile,
      reason: "turn",
      sessionManager: params.sessionManager,
      runtimeContext: params.runtimeContext,
      runtimeSettings: params.runtimeSettings,
      agentId: params.agentId,
      config: params.config,
      executionMode: "background",
      maintenanceFence: params.maintenanceFence,
      persistenceCheckpoint: params.persistenceCheckpoint,
    });
    if (longRunningTimer) {
      clearTimeout(longRunningTimer);
      longRunningTimer = null;
    }

    // The lane timeout fires the fence and cancels the descriptor; a worker that
    // finishes afterward must not flip the cancelled task to succeeded.
    if (params.maintenanceFence.tripped) {
      return;
    }

    const endedAt = Date.now();
    completeTaskRunByRunId({
      runId: params.runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
      endedAt,
      lastEventAt: endedAt,
      progressSummary: result?.changed
        ? "Deferred maintenance completed with transcript changes."
        : "Deferred maintenance completed.",
      terminalSummary: result?.changed
        ? `Rewrote ${result.rewrittenEntries} transcript entr${result.rewrittenEntries === 1 ? "y" : "ies"} and freed ${result.bytesFreed} bytes.`
        : "No transcript changes were needed.",
    });
  } catch (err) {
    if (shutdownAbort.abortSignal?.aborted) {
      if (longRunningTimer) {
        clearTimeout(longRunningTimer);
        longRunningTimer = null;
      }
      const task = findTaskByRunIdForOwner({
        runId: params.runId,
        callerOwnerKey: params.sessionKey,
      });
      if (task) {
        cancelTaskByIdForOwner({
          taskId: task.taskId,
          callerOwnerKey: params.sessionKey,
          endedAt: Date.now(),
          terminalSummary: "Deferred maintenance cancelled during shutdown.",
        });
      }
      return;
    }
    if (longRunningTimer) {
      clearTimeout(longRunningTimer);
      longRunningTimer = null;
    }
    // A timed-out run is already cancelled; do not flip it to failed.
    if (params.maintenanceFence.tripped) {
      return;
    }
    const endedAt = Date.now();
    const reason = formatErrorMessage(err);
    if (!surfacedUserNotice) {
      promoteTurnMaintenanceTaskVisibility({
        sessionKey: params.sessionKey,
        runId: params.runId,
        notifyPolicy: "done_only",
      });
    }
    failTaskRunByRunId({
      runId: params.runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
      endedAt,
      lastEventAt: endedAt,
      error: reason,
      progressSummary: "Deferred maintenance failed.",
      terminalSummary: reason,
    });
    log.warn(`deferred context engine maintenance failed: ${reason}`);
  } finally {
    shutdownAbort.dispose();
    if (params.disposeContextEngineAfterMaintenance) {
      await disposeDeferredMaintenanceContextEngine(params.contextEngine);
    }
  }
}

function scheduleDeferredTurnMaintenance(
  params: DeferredTurnMaintenanceScheduleParams,
): Promise<void> | undefined {
  const sessionKey = normalizeSessionKey(params.sessionKey);
  if (!sessionKey) {
    return undefined;
  }
  if (isGatewayDraining()) {
    params.onScheduleFailure?.(new GatewayDrainingError());
    return undefined;
  }

  const activeRun = activeDeferredTurnMaintenanceRuns.get(sessionKey);
  if (activeRun) {
    const supersededParams = activeRun.rerunRequested ? activeRun.latestParams : undefined;
    activeRun.rerunRequested = true;
    activeRun.latestParams = { ...params, sessionKey };
    if (
      supersededParams?.disposeContextEngineAfterMaintenance &&
      supersededParams.contextEngine !== params.contextEngine
    ) {
      void disposeDeferredMaintenanceContextEngine(supersededParams.contextEngine);
    }
    return activeRun.promise;
  }

  const existingTask = findActiveSessionTask({
    sessionKey,
    runtime: "acp",
    taskKind: TURN_MAINTENANCE_TASK_KIND,
  });
  const reusableTask = existingTask?.runId?.trim() ? existingTask : undefined;
  if (existingTask && !reusableTask) {
    updateTaskNotifyPolicyForOwner({
      taskId: existingTask.taskId,
      callerOwnerKey: sessionKey,
      notifyPolicy: "silent",
    });
    cancelTaskByIdForOwner({
      taskId: existingTask.taskId,
      callerOwnerKey: sessionKey,
      endedAt: Date.now(),
      terminalSummary: "Superseded by refreshed deferred maintenance task.",
    });
  }
  const task =
    reusableTask ??
    buildTurnMaintenanceTaskDescriptor({
      sessionKey,
    });
  if (!task) {
    log.warn("[context-engine] failed to create deferred turn maintenance task", { sessionKey });
    return undefined;
  }
  // Resolve the lane once and reuse it for the enqueue and the timeout
  // classification below so the two can never drift onto different lanes.
  const maintenanceLane = resolveDeferredTurnMaintenanceLane(sessionKey);
  log.info(
    `[context-engine] deferred turn maintenance ${reusableTask ? "resuming" : "queued"} ` +
      `taskId=${task.taskId} sessionKey=${sessionKey} lane=${maintenanceLane}`,
  );

  const schedulerAbort = createDeferredTurnMaintenanceAbortSignal();
  const taskTimeoutMs = resolveDeferredTurnMaintenanceTaskTimeoutMs(params.config);
  // Tripped by the queue timeout hook (and defensively in the timeout catch
  // below). The worker and its transcript-rewrite helper read it to suppress
  // late side effects once the lane has been released to a queued user turn.
  const maintenanceFence: DeferredTurnMaintenanceFence = { tripped: false };
  // Bounded read checkpoint (issue #96703): the lane releases at the timeout
  // point for liveness, but a persist admitted just before the timeout may still
  // be writing. The timeout path awaits this before resolving the read barrier so
  // the next same-session read sees a settled (or fenced no-op) transcript.
  const persistenceCheckpoint = createDeferredTurnMaintenancePersistenceCheckpoint();
  // Opt-in bound: with no positive config the lane arms no timeout and the fence
  // never trips, so background maintenance runs unbounded exactly as before the
  // bound existed. A positive value arms both (issue #96703).
  const taskTimeoutOptions =
    taskTimeoutMs === undefined
      ? {}
      : {
          taskTimeoutMs,
          onTaskTimeout: () => {
            maintenanceFence.tripped = true;
          },
        };
  let runPromise: Promise<void>;
  try {
    runPromise = enqueueCommandInLane(
      maintenanceLane,
      async () =>
        runDeferredTurnMaintenanceWorker({
          contextEngine: params.contextEngine,
          sessionId: params.sessionId,
          sessionKey,
          sessionTarget: params.sessionTarget,
          sessionFile: params.sessionFile,
          sessionManager: params.sessionManager,
          runtimeContext: params.runtimeContext,
          runtimeSettings: params.runtimeSettings,
          agentId: params.agentId,
          config: params.config,
          runId: task.runId!,
          disposeContextEngineAfterMaintenance: params.disposeContextEngineAfterMaintenance,
          maintenanceFence,
          persistenceCheckpoint,
        }),
      // When armed, on timeout the lane is released and the enqueue promise
      // rejects with CommandLaneTaskTimeoutError. The onTaskTimeout hook flips
      // the fence synchronously at that moment so the still-running worker
      // suppresses its remaining transcript/task side effects (a rewrite already
      // mid-persist is serialized by the session write lock).
      taskTimeoutOptions,
    );
  } catch (err) {
    schedulerAbort.dispose();
    markDeferredTurnMaintenanceTaskScheduleFailure({
      sessionKey,
      taskId: task.taskId,
      error: err,
    });
    return undefined;
  }
  const cleanupDeferredTurnMaintenance = async () => {
    schedulerAbort.dispose();
    const current = activeDeferredTurnMaintenanceRuns.get(sessionKey);
    if (current !== state) {
      return;
    }
    const shutdownTriggered = schedulerAbort.abortSignal?.aborted === true;
    const rerunParams =
      current.rerunRequested && !shutdownTriggered ? current.latestParams : undefined;
    const discardedRerunParams =
      current.rerunRequested && shutdownTriggered ? current.latestParams : undefined;
    activeDeferredTurnMaintenanceRuns.delete(sessionKey);
    if (rerunParams) {
      await scheduleDeferredTurnMaintenance(rerunParams);
    } else if (discardedRerunParams?.disposeContextEngineAfterMaintenance) {
      await disposeDeferredMaintenanceContextEngine(discardedRerunParams.contextEngine);
    }
  };
  const trackedPromise = runPromise
    .catch(async (err: unknown) => {
      params.onScheduleFailure?.(err);
      // A wedged worker that blew past taskTimeoutMs surfaces here as a lane
      // timeout. The worker may still be unwinding in the background, but the
      // lane is already free; release the task descriptor so the session no
      // longer treats maintenance as active and the queued turn can proceed.
      // Scope the match to this maintenance lane: only THIS lane's timeout trips
      // the fence/timeout path. A foreign-lane timeout error falls through to the
      // normal schedule-failure path below.
      if (taskTimeoutMs !== undefined && isCommandLaneTaskTimeoutError(err, maintenanceLane)) {
        // Defensive: the onTaskTimeout hook already flipped this, but keep the
        // fence authoritative even if the hook path changes.
        maintenanceFence.tripped = true;
        markDeferredTurnMaintenanceTaskTimeout({
          sessionKey,
          taskId: task.taskId,
          timeoutMs: taskTimeoutMs,
        });
        // Bounded belt-and-suspenders: a persist admitted before the timeout may
        // still be writing. Hold the read barrier for that single write to settle
        // (the fence already stops any new persist), so the next same-session read
        // never observes a half-applied rewrite. The load-bearing safety is the
        // write-side fence in transcript-rewrite.ts; this only tightens the read.
        await persistenceCheckpoint.waitForInFlight();
        return;
      }
      markDeferredTurnMaintenanceTaskScheduleFailure({
        sessionKey,
        taskId: task.taskId,
        error: err,
      });
    })
    .then(cleanupDeferredTurnMaintenance, async (err: unknown) => {
      await cleanupDeferredTurnMaintenance();
      throw err;
    });
  const state: DeferredTurnMaintenanceRunState = {
    promise: trackedPromise,
    rerunRequested: false,
    latestParams: { ...params, sessionKey },
  };
  activeDeferredTurnMaintenanceRuns.set(sessionKey, state);
  void trackedPromise;
  return trackedPromise;
}

/**
 * Run optional context-engine transcript maintenance and normalize the result.
 */
export async function runContextEngineMaintenance(params: {
  contextEngine?: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
  sessionFile: string;
  reason: "bootstrap" | "compaction" | "turn";
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  withSessionManagerRewriteLock?: SessionManagerRewriteLock;
  runtimeContext?: ContextEngineRuntimeContext;
  runtimeSettings?: ContextEngineRuntimeSettings;
  agentId?: string;
  executionMode?: "foreground" | "background";
  onDeferredMaintenance?: (promise: Promise<void>) => void;
  onDeferredMaintenanceFailure?: (error: unknown) => void;
  config?: OpenClawConfig;
  disposeDeferredContextEngineAfterMaintenance?: boolean;
}): Promise<ContextEngineMaintenanceResult | undefined> {
  if (typeof params.contextEngine?.maintain !== "function") {
    return undefined;
  }

  const executionMode = params.executionMode ?? "foreground";
  const shouldDefer =
    params.reason === "turn" &&
    executionMode !== "background" &&
    params.contextEngine.info.turnMaintenanceMode === "background";

  if (shouldDefer) {
    try {
      const deferred = scheduleDeferredTurnMaintenance({
        contextEngine: params.contextEngine,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey ?? params.sessionId,
        sessionTarget: params.sessionTarget,
        sessionFile: params.sessionFile,
        sessionManager: params.sessionManager,
        runtimeContext: params.runtimeContext,
        runtimeSettings: params.runtimeSettings,
        agentId: params.agentId,
        config: params.config,
        disposeContextEngineAfterMaintenance: params.disposeDeferredContextEngineAfterMaintenance,
        onScheduleFailure: params.onDeferredMaintenanceFailure,
      });
      if (deferred) {
        params.onDeferredMaintenance?.(deferred);
      }
    } catch (err) {
      log.warn(`failed to schedule deferred context engine maintenance: ${String(err)}`);
    }
    return undefined;
  }

  try {
    return await executeContextEngineMaintenance({
      contextEngine: params.contextEngine,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionTarget: params.sessionTarget,
      sessionFile: params.sessionFile,
      reason: params.reason,
      sessionManager: params.sessionManager,
      withSessionManagerRewriteLock: params.withSessionManagerRewriteLock,
      runtimeContext: params.runtimeContext,
      runtimeSettings: params.runtimeSettings,
      agentId: params.agentId,
      executionMode,
      config: params.config,
    });
  } catch (err) {
    log.warn(`context engine maintain failed (${params.reason}): ${String(err)}`);
    return undefined;
  }
}
