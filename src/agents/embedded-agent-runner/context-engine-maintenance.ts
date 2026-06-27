/**
 * Schedules and runs deferred context-engine turn maintenance.
 */
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveContextEngineOwnerPluginId } from "../../context-engine/registry.js";
import type {
  ContextEngine,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
  ContextEngineSessionTarget,
  TranscriptRewriteResult,
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
  createQueuedTaskRun,
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
import { log } from "./logger.js";
import {
  rewriteTranscriptEntriesInRuntimeTranscript,
  rewriteTranscriptEntriesInSessionManager,
} from "./transcript-rewrite.js";

const TURN_MAINTENANCE_TASK_KIND = "context_engine_turn_maintenance";
const TURN_MAINTENANCE_TASK_LABEL = "Context engine turn maintenance";
const TURN_MAINTENANCE_TASK_TASK = "Deferred context-engine maintenance after turn.";
const TURN_MAINTENANCE_LANE_PREFIX = "context-engine-turn-maintenance:";
const TURN_MAINTENANCE_LONG_WAIT_MS = 10_000;
// Bounds a single deferred maintenance run so a wedged worker (e.g. plugin lock
// contention) releases its lane in seconds instead of blocking a queued user
// message until the session-level abort fires. Overridable per deployment.
const DEFERRED_TURN_MAINTENANCE_TASK_TIMEOUT_MS = 120_000;
const DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY = Symbol.for(
  "openclaw.contextEngineTurnMaintenanceAbortState",
);

/**
 * Per-run safety fence shared between the queue timeout hook and the running
 * worker. Once a deferred run times out the lane is released and a queued user
 * turn can proceed, so a worker still unwinding must not perform late side
 * effects (transcript rewrite, task complete/fail, progress) against state the
 * foreground turn has already read.
 */
type DeferredTurnMaintenanceFence = { tripped: boolean };

function fencedTranscriptRewriteResult(): TranscriptRewriteResult {
  return {
    changed: false,
    bytesFreed: 0,
    rewrittenEntries: 0,
    reason: "maintenance fenced after timeout",
  };
}

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

type DeferredTurnMaintenanceSignal = "SIGINT" | "SIGTERM";
type DeferredTurnMaintenanceProcessLike = Pick<NodeJS.Process, "on" | "off"> &
  Partial<Pick<NodeJS.Process, "listenerCount" | "kill" | "pid">> & {
    [DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY]?: DeferredTurnMaintenanceAbortState;
  };
type DeferredTurnMaintenanceAbortState = {
  registered: boolean;
  controllers: Set<AbortController>;
  cleanupHandlers: Map<DeferredTurnMaintenanceSignal, () => void>;
};

function resolveDeferredTurnMaintenanceAbortState(
  processLike: DeferredTurnMaintenanceProcessLike,
): DeferredTurnMaintenanceAbortState {
  const existing = processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY];
  if (existing) {
    return existing;
  }
  const created: DeferredTurnMaintenanceAbortState = {
    registered: false,
    controllers: new Set<AbortController>(),
    cleanupHandlers: new Map<DeferredTurnMaintenanceSignal, () => void>(),
  };
  processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY] = created;
  return created;
}

function unregisterDeferredTurnMaintenanceAbortSignalHandlers(
  processLike: DeferredTurnMaintenanceProcessLike,
  state: DeferredTurnMaintenanceAbortState,
): void {
  if (!state.registered) {
    return;
  }
  for (const [signal, handler] of state.cleanupHandlers) {
    processLike.off(signal, handler);
  }
  state.cleanupHandlers.clear();
  state.registered = false;
}

function normalizeSessionKey(sessionKey?: string): string | undefined {
  return normalizeOptionalString(sessionKey) || undefined;
}

function resolveDeferredTurnMaintenanceLane(sessionKey: string): string {
  return `${TURN_MAINTENANCE_LANE_PREFIX}${sessionKey}`;
}

function resolveDeferredTurnMaintenanceTaskTimeoutMs(config?: OpenClawConfig): number {
  const configured = config?.agents?.defaults?.compaction?.turnMaintenanceTaskTimeoutMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFERRED_TURN_MAINTENANCE_TASK_TIMEOUT_MS;
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

function createDeferredTurnMaintenanceAbortSignal(params?: {
  processLike?: DeferredTurnMaintenanceProcessLike;
}): {
  abortSignal?: AbortSignal;
  dispose: () => void;
} {
  if (typeof AbortController === "undefined") {
    return { abortSignal: undefined, dispose: () => {} };
  }

  const processLike = (params?.processLike ?? process) as DeferredTurnMaintenanceProcessLike;
  const state = resolveDeferredTurnMaintenanceAbortState(processLike);
  const handleTerminationSignal = (signalName: DeferredTurnMaintenanceSignal) => {
    const shouldReraise =
      typeof processLike.listenerCount === "function"
        ? processLike.listenerCount(signalName) === 1
        : false;
    for (const activeController of state.controllers) {
      if (!activeController.signal.aborted) {
        activeController.abort(
          new Error(`received ${signalName} while waiting for deferred maintenance`),
        );
      }
    }
    state.controllers.clear();
    unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
    if (shouldReraise && typeof processLike.kill === "function") {
      try {
        processLike.kill(processLike.pid ?? process.pid, signalName);
      } catch {
        // Ignore shutdown-path failures.
      }
    }
  };
  if (!state.registered) {
    state.registered = true;
    const onSigint = () => handleTerminationSignal("SIGINT");
    const onSigterm = () => handleTerminationSignal("SIGTERM");
    state.cleanupHandlers.set("SIGINT", onSigint);
    state.cleanupHandlers.set("SIGTERM", onSigterm);
    processLike.on("SIGINT", onSigint);
    processLike.on("SIGTERM", onSigterm);
  }

  const controller = new AbortController();
  state.controllers.add(controller);
  let disposed = false;

  const cleanup = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    state.controllers.delete(controller);
    if (state.controllers.size === 0) {
      unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
    }
  };

  return {
    abortSignal: controller.signal,
    dispose: cleanup,
  };
}

function resetDeferredTurnMaintenanceStateForTest(): void {
  activeDeferredTurnMaintenanceRuns.clear();
  const processLike = process as DeferredTurnMaintenanceProcessLike;
  const state = processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY];
  if (!state) {
    return;
  }
  state.controllers.clear();
  unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
  delete processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY];
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

function markDeferredTurnMaintenanceTaskScheduleFailure(params: {
  sessionKey: string;
  taskId: string;
  error: unknown;
}): void {
  const errorMessage = formatErrorMessage(params.error);
  log.warn(`failed to schedule deferred context engine maintenance: ${errorMessage}`);
  cancelTaskByIdForOwner({
    taskId: params.taskId,
    callerOwnerKey: params.sessionKey,
    endedAt: Date.now(),
    terminalSummary: `Deferred maintenance could not be scheduled: ${errorMessage}`,
  });
}

function markDeferredTurnMaintenanceTaskTimeout(params: {
  sessionKey: string;
  taskId: string;
  timeoutMs: number;
}): void {
  log.warn(
    `deferred context engine maintenance timed out: sessionKey=${params.sessionKey} ` +
      `taskId=${params.taskId} taskTimeoutMs=${params.timeoutMs}`,
  );
  cancelTaskByIdForOwner({
    taskId: params.taskId,
    callerOwnerKey: params.sessionKey,
    endedAt: Date.now(),
    terminalSummary: `Deferred maintenance timed out after ${params.timeoutMs}ms.`,
  });
}

function buildTurnMaintenanceTaskDescriptor(params: {
  sessionKey: string;
  runId?: string;
  notifyPolicy?: "silent" | "done_only" | "state_changes";
  deliveryStatus?: "not_applicable" | "pending";
}) {
  const runId =
    params.runId ??
    `turn-maint:${params.sessionKey}:${Date.now().toString(36)}:${randomUUID().slice(0, 8)}`;
  return createQueuedTaskRun({
    runtime: "acp",
    taskKind: TURN_MAINTENANCE_TASK_KIND,
    sourceId: TURN_MAINTENANCE_TASK_KIND,
    requesterSessionKey: params.sessionKey,
    ownerKey: params.sessionKey,
    scopeKind: "session",
    runId,
    label: TURN_MAINTENANCE_TASK_LABEL,
    task: TURN_MAINTENANCE_TASK_TASK,
    notifyPolicy: params.notifyPolicy ?? "silent",
    // Fast maintenance stays silent and must not create a one-task flow.
    // Long-running and failed workers promote it to pending before notifying.
    deliveryStatus: params.deliveryStatus ?? "not_applicable",
    preferMetadata: true,
  });
}

function promoteTurnMaintenanceTaskVisibility(params: {
  sessionKey: string;
  runId: string;
  notifyPolicy: "done_only" | "state_changes";
}) {
  return buildTurnMaintenanceTaskDescriptor({
    sessionKey: params.sessionKey,
    runId: params.runId,
    notifyPolicy: params.notifyPolicy,
    deliveryStatus: "pending",
  });
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
      return await rewriteRuntimeTranscriptEntries();
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
  log.info(
    `[context-engine] deferred turn maintenance ${reusableTask ? "resuming" : "queued"} ` +
      `taskId=${task.taskId} sessionKey=${sessionKey} lane=${resolveDeferredTurnMaintenanceLane(sessionKey)}`,
  );

  const schedulerAbort = createDeferredTurnMaintenanceAbortSignal();
  const taskTimeoutMs = resolveDeferredTurnMaintenanceTaskTimeoutMs(params.config);
  // Tripped by the queue timeout hook (and defensively in the timeout catch
  // below). The worker and its transcript-rewrite helper read it to suppress
  // late side effects once the lane has been released to a queued user turn.
  const maintenanceFence: DeferredTurnMaintenanceFence = { tripped: false };
  let runPromise: Promise<void>;
  try {
    runPromise = enqueueCommandInLane(
      resolveDeferredTurnMaintenanceLane(sessionKey),
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
        }),
      // Bound a wedged maintenance run: on timeout the lane is released and the
      // enqueue promise rejects with CommandLaneTaskTimeoutError. The
      // onTaskTimeout hook flips the fence synchronously at that moment so the
      // still-running worker suppresses its remaining transcript/task side
      // effects (a rewrite already mid-persist is serialized by the session
      // write lock).
      {
        taskTimeoutMs,
        onTaskTimeout: () => {
          maintenanceFence.tripped = true;
        },
      },
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
    .catch((err: unknown) => {
      params.onScheduleFailure?.(err);
      // A wedged worker that blew past taskTimeoutMs surfaces here as a lane
      // timeout. The worker may still be unwinding in the background, but the
      // lane is already free; release the task descriptor so the session no
      // longer treats maintenance as active and the queued turn can proceed.
      if (isCommandLaneTaskTimeoutError(err)) {
        // Defensive: the onTaskTimeout hook already flipped this, but keep the
        // fence authoritative even if the hook path changes.
        maintenanceFence.tripped = true;
        markDeferredTurnMaintenanceTaskTimeout({
          sessionKey,
          taskId: task.taskId,
          timeoutMs: taskTimeoutMs,
        });
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
