/**
 * Schedules and runs deferred context-engine turn maintenance.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasSameContextEngineInstance,
  isContextEngineAbortRejection,
} from "../../context-engine/registry.js";
import type { ContextEngine, ContextEngineMaintenanceResult } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  enqueueCommandInLane,
  GatewayDrainingError,
  isGatewayDraining,
} from "../../process/command-queue.js";
import {
  getGatewayRestartDrainSignal,
  retainGatewayRootWorkAdmissionContinuation,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND as TURN_MAINTENANCE_TASK_KIND,
  isContextEngineMaintenanceTaskOwnerActive,
  registerContextEngineMaintenanceTaskOwner,
} from "../../tasks/context-engine-maintenance-task-owner.js";
import {
  completeTaskRunByRunIdAsync,
  failTaskRunByRunIdAsync,
  startTaskRunByRunIdAsync,
} from "../../tasks/detached-task-runtime.async.js";
import { recordTaskRunProgressByRunId } from "../../tasks/detached-task-runtime.js";
import {
  cancelTaskByIdForOwner,
  findTaskByRunIdForOwner,
  updateTaskNotifyPolicyForOwner,
} from "../../tasks/task-owner-access.js";
import { findActiveSessionTask } from "../session-async-task-status.js";
import {
  createSessionMaintenanceOwner,
  waitForSessionMaintenance,
} from "../session-maintenance/coordinator.js";
import { executeContextEngineMaintenance } from "./context-engine-maintenance-execution.js";
import {
  buildTurnMaintenanceTaskDescriptor,
  disposeDeferredMaintenanceContextEngine,
  mergeContextEngineFactoryWork,
  runContextEngineMaintenanceWork,
  type ContextEngineMaintenanceResources,
} from "./context-engine-maintenance-work.js";
import type { ContextEngineMaintenanceParams } from "./context-engine-maintenance.types.js";
import { log } from "./logger.js";

const TURN_MAINTENANCE_LANE_PREFIX = "context-engine-turn-maintenance:";
const TURN_MAINTENANCE_LONG_WAIT_MS = 10_000;
const DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY = Symbol.for(
  "openclaw.contextEngineTurnMaintenanceAbortState",
);

type DeferredTurnMaintenanceScheduleParams = ContextEngineMaintenanceParams & {
  contextEngine: ContextEngine;
  sessionKey: string;
  runInContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
  disposeContextEngineAfterMaintenance?: boolean;
  onScheduleFailure?: (error: unknown) => void;
  factoryResourceOwners: Set<ContextEngineMaintenanceResources>;
};

type DeferredTurnMaintenanceRunState = {
  maintenance: ReturnType<typeof createSessionMaintenanceOwner>;
  pendingDisposals: Set<Promise<void>>;
  promise: Promise<void>;
  rerunRequested: boolean;
  activeContextEngine: ContextEngine;
  activeFactoryResourceOwners: Set<ContextEngineMaintenanceResources>;
  disposeActiveContextEngineAfterMaintenance: boolean;
  latestParams: DeferredTurnMaintenanceScheduleParams;
};

const activeDeferredTurnMaintenanceRuns = new Map<string, DeferredTurnMaintenanceRunState>();

type DeferredTurnMaintenanceSignal = "SIGINT" | "SIGTERM";
type DeferredTurnMaintenanceProcessLike = Pick<NodeJS.Process, "on" | "off"> &
  Partial<Pick<NodeJS.Process, "listenerCount" | "kill" | "pid">> & {
    [DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY]?: DeferredTurnMaintenanceAbortState;
  };
type DeferredTurnMaintenanceAbortState = {
  controllers: Set<AbortController>;
  cleanupHandlers: Map<DeferredTurnMaintenanceSignal, () => void>;
};

function unregisterDeferredTurnMaintenanceAbortSignalHandlers(
  processLike: DeferredTurnMaintenanceProcessLike,
  state: DeferredTurnMaintenanceAbortState,
): void {
  for (const [signal, handler] of state.cleanupHandlers) {
    processLike.off(signal, handler);
  }
  state.cleanupHandlers.clear();
}

function createDeferredTurnMaintenanceAbortSignal(params?: {
  processLike?: DeferredTurnMaintenanceProcessLike;
}): {
  abortSignal: AbortSignal;
  dispose: () => void;
} {
  const processLike = (params?.processLike ?? process) as DeferredTurnMaintenanceProcessLike;
  const state = (processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY] ??= {
    controllers: new Set<AbortController>(),
    cleanupHandlers: new Map<DeferredTurnMaintenanceSignal, () => void>(),
  });
  const handleTerminationSignal = (signalName: DeferredTurnMaintenanceSignal) => {
    const shouldReraise = processLike.listenerCount?.(signalName) === 1;
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
  if (state.cleanupHandlers.size === 0) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => handleTerminationSignal(signal);
      state.cleanupHandlers.set(signal, handler);
      processLike.on(signal, handler);
    }
  }

  const controller = new AbortController();
  const abortSignal = AbortSignal.any([controller.signal, getGatewayRestartDrainSignal()]);
  state.controllers.add(controller);
  return {
    abortSignal,
    dispose: () => {
      state.controllers.delete(controller);
      if (state.controllers.size === 0) {
        unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
      }
    },
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
  await waitForSessionMaintenance(sessionKey);
}

async function runDeferredTurnMaintenanceWorker(
  params: DeferredTurnMaintenanceScheduleParams & {
    abortSignal: AbortSignal;
    runId: string;
    assertTaskSettlementCurrent: () => void;
  },
): Promise<void> {
  let surfacedUserNotice = false;
  const taskRun = { runId: params.runId, runtime: "acp" as const, sessionKey: params.sessionKey };
  const makeTaskVisible = (notifyPolicy: "done_only" | "state_changes") =>
    buildTurnMaintenanceTaskDescriptor({
      sessionKey: params.sessionKey,
      runId: params.runId,
      notifyPolicy,
      deliveryStatus: "pending",
    });

  try {
    const runningAt = Date.now();
    // Admit running state through the same retained workers that will settle completion.
    await startTaskRunByRunIdAsync(
      {
        ...taskRun,
        startedAt: runningAt,
        lastEventAt: runningAt,
        progressSummary: "Running deferred maintenance.",
        eventSummary: "Starting deferred maintenance.",
      },
      params.assertActive,
    );
    const longRunningTimer = setTimeout(() => {
      try {
        makeTaskVisible("state_changes");
        surfacedUserNotice = true;
        const summary = "Deferred maintenance is still running.";
        recordTaskRunProgressByRunId({
          ...taskRun,
          lastEventAt: Date.now(),
          progressSummary: summary,
          eventSummary: summary,
        });
      } catch (error) {
        log.warn(`failed to surface deferred maintenance progress: ${String(error)}`);
      }
    }, TURN_MAINTENANCE_LONG_WAIT_MS);

    const result = await executeContextEngineMaintenance({
      ...params,
      executionMode: "background",
    }).finally(() => clearTimeout(longRunningTimer));
    const endedAt = Date.now();
    await completeTaskRunByRunIdAsync(
      {
        ...taskRun,
        endedAt,
        lastEventAt: endedAt,
        progressSummary: result?.changed
          ? "Deferred maintenance completed with transcript changes."
          : "Deferred maintenance completed.",
        terminalSummary: result?.changed
          ? `Rewrote ${result.rewrittenEntries} transcript entr${result.rewrittenEntries === 1 ? "y" : "ies"} and freed ${result.bytesFreed} bytes.`
          : "No transcript changes were needed.",
      },
      params.assertActive,
    );
  } catch (err) {
    if (isContextEngineAbortRejection(err, params.abortSignal)) {
      const task = findTaskByRunIdForOwner({
        runId: params.runId,
        callerOwnerKey: params.sessionKey,
        callerAgentId: params.agentId,
        config: params.config,
      });
      if (task) {
        cancelTaskByIdForOwner({
          taskId: task.taskId,
          callerOwnerKey: params.sessionKey,
          callerAgentId: params.agentId,
          config: params.config,
          endedAt: Date.now(),
          terminalSummary: "Deferred maintenance cancelled during shutdown.",
        });
      }
      return;
    }
    const endedAt = Date.now();
    const reason = formatErrorMessage(err);
    if (!surfacedUserNotice) {
      makeTaskVisible("done_only");
    }
    await failTaskRunByRunIdAsync(
      {
        ...taskRun,
        endedAt,
        lastEventAt: endedAt,
        error: reason,
        progressSummary: "Deferred maintenance failed.",
        terminalSummary: reason,
      },
      params.assertTaskSettlementCurrent,
    );
    log.warn(`deferred context engine maintenance failed: ${reason}`);
  }
}

function scheduleDeferredTurnMaintenance(
  params: DeferredTurnMaintenanceScheduleParams,
): Promise<void> | undefined {
  const { sessionKey } = params;
  if (isGatewayDraining()) {
    params.onScheduleFailure?.(new GatewayDrainingError());
    return undefined;
  }

  const activeRun = activeDeferredTurnMaintenanceRuns.get(sessionKey);
  if (activeRun) {
    const supersededParams = activeRun.rerunRequested ? activeRun.latestParams : undefined;
    const latestParams = { ...params, sessionKey };
    latestParams.factoryResourceOwners = mergeContextEngineFactoryWork(
      latestParams,
      activeRun.activeContextEngine,
      activeRun.activeFactoryResourceOwners,
      supersededParams,
    );
    // Coalesced resolutions may wrap one shared factory instance. Carry disposal
    // ownership forward without closing an engine still used by active or newer work.
    if (
      supersededParams?.disposeContextEngineAfterMaintenance &&
      hasSameContextEngineInstance(supersededParams.contextEngine, latestParams.contextEngine)
    ) {
      latestParams.disposeContextEngineAfterMaintenance = true;
    }
    if (
      latestParams.disposeContextEngineAfterMaintenance &&
      hasSameContextEngineInstance(latestParams.contextEngine, activeRun.activeContextEngine)
    ) {
      activeRun.disposeActiveContextEngineAfterMaintenance = true;
    }
    activeRun.rerunRequested = true;
    activeRun.latestParams = latestParams;
    if (
      supersededParams?.disposeContextEngineAfterMaintenance &&
      !hasSameContextEngineInstance(
        supersededParams.contextEngine,
        activeRun.activeContextEngine,
      ) &&
      !hasSameContextEngineInstance(supersededParams.contextEngine, latestParams.contextEngine)
    ) {
      const disposal = disposeDeferredMaintenanceContextEngine(
        supersededParams,
        activeRun.maintenance,
      );
      activeRun.pendingDisposals.add(disposal);
      void disposal.finally(() => activeRun.pendingDisposals.delete(disposal));
    }
    return activeRun.promise;
  }

  const schedulerAbort = createDeferredTurnMaintenanceAbortSignal();
  const maintenance = createSessionMaintenanceOwner({
    sessionKey,
    abortSignal: schedulerAbort.abortSignal,
  });
  const completion = createDeferredCore();
  const pendingDisposals = new Set<Promise<void>>();
  const state: DeferredTurnMaintenanceRunState = {
    maintenance,
    pendingDisposals,
    promise: maintenance.track(completion.promise),
    rerunRequested: false,
    activeContextEngine: params.contextEngine,
    activeFactoryResourceOwners: params.factoryResourceOwners,
    disposeActiveContextEngineAfterMaintenance:
      params.disposeContextEngineAfterMaintenance === true,
    latestParams: { ...params, sessionKey },
  };
  // Lookup and synchronous creation can publish observers that schedule this session again.
  activeDeferredTurnMaintenanceRuns.set(sessionKey, state);
  let task: ReturnType<typeof buildTurnMaintenanceTaskDescriptor> | undefined;
  let releaseProcessOwner: (() => void) | undefined;
  const cancelFailedTask = (error: unknown) => {
    const errorMessage = formatErrorMessage(error);
    log.warn(`failed to schedule deferred context engine maintenance: ${errorMessage}`);
    if (task) {
      cancelTaskByIdForOwner({
        taskId: task.taskId,
        callerOwnerKey: sessionKey,
        callerAgentId: params.agentId,
        config: params.config,
        endedAt: Date.now(),
        terminalSummary: `Deferred maintenance could not be scheduled: ${errorMessage}`,
      });
    }
  };
  const cleanupDeferredTurnMaintenance = () =>
    maintenance.run(async () => {
      releaseProcessOwner?.();
      const current = activeDeferredTurnMaintenanceRuns.get(sessionKey);
      if (current !== state) {
        return;
      }
      const shutdownTriggered = maintenance.signal.aborted;
      const rerunParams =
        current.rerunRequested && !shutdownTriggered ? current.latestParams : undefined;
      const discardedRerunParams =
        current.rerunRequested && shutdownTriggered ? current.latestParams : undefined;
      activeDeferredTurnMaintenanceRuns.delete(sessionKey);
      if (rerunParams) {
        const rerunSharesActiveEngine = hasSameContextEngineInstance(
          rerunParams.contextEngine,
          current.activeContextEngine,
        );
        if (!rerunSharesActiveEngine && current.disposeActiveContextEngineAfterMaintenance) {
          await disposeDeferredMaintenanceContextEngine(params, maintenance);
        }
        const nextParams =
          rerunSharesActiveEngine && current.disposeActiveContextEngineAfterMaintenance
            ? { ...rerunParams, disposeContextEngineAfterMaintenance: true }
            : rerunParams;
        // Disposal can await a lifecycle rotation. Retired work cannot mint a fresh rerun.
        if (maintenance.signal.aborted) {
          if (nextParams.disposeContextEngineAfterMaintenance) {
            await disposeDeferredMaintenanceContextEngine(nextParams, maintenance);
          }
          return;
        }
        // The parent still joins its rerun, but no longer owns writes that block that child.
        maintenance.releaseWrites();
        const scheduledRerun = scheduleDeferredTurnMaintenance(nextParams);
        if (!scheduledRerun && nextParams.disposeContextEngineAfterMaintenance) {
          await disposeDeferredMaintenanceContextEngine(nextParams, maintenance);
        } else {
          await scheduledRerun;
        }
        return;
      }
      if (current.disposeActiveContextEngineAfterMaintenance) {
        await disposeDeferredMaintenanceContextEngine(params, maintenance);
      }
      if (
        discardedRerunParams?.disposeContextEngineAfterMaintenance &&
        !hasSameContextEngineInstance(
          discardedRerunParams.contextEngine,
          current.activeContextEngine,
        )
      ) {
        await disposeDeferredMaintenanceContextEngine(discardedRerunParams, maintenance);
      }
    });
  const run = async () => {
    try {
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
          callerAgentId: params.agentId,
          config: params.config,
          notifyPolicy: "silent",
        });
        cancelTaskByIdForOwner({
          taskId: existingTask.taskId,
          callerOwnerKey: sessionKey,
          callerAgentId: params.agentId,
          config: params.config,
          endedAt: Date.now(),
          terminalSummary: "Superseded by refreshed deferred maintenance task.",
        });
      }
      task = reusableTask ?? buildTurnMaintenanceTaskDescriptor({ sessionKey });
      if (!task) {
        throw new Error("Failed to create deferred turn maintenance task");
      }
      const lane = `${TURN_MAINTENANCE_LANE_PREFIX}${sessionKey}`;
      log.info(
        `[context-engine] deferred turn maintenance ${reusableTask ? "resuming" : "queued"} ` +
          `taskId=${task.taskId} sessionKey=${sessionKey} lane=${lane}`,
      );
      // Durable rows need a process owner before the engine is admitted to its lane.
      const taskId = task.taskId;
      releaseProcessOwner = registerContextEngineMaintenanceTaskOwner(taskId);
      const runId = task.runId!;
      await enqueueCommandInLane(lane, () =>
        params.runInContext(() =>
          maintenance.run(() =>
            runContextEngineMaintenanceWork(
              () =>
                runDeferredTurnMaintenanceWorker({
                  ...params,
                  abortSignal: maintenance.signal,
                  assertActive: () => {
                    maintenance.assertCurrent();
                    params.assertActive?.();
                  },
                  assertTaskSettlementCurrent: () => {
                    // Shutdown stops execution, but this retained owner still owes failure settlement.
                    if (
                      activeDeferredTurnMaintenanceRuns.get(sessionKey) !== state ||
                      !isContextEngineMaintenanceTaskOwnerActive(taskId)
                    ) {
                      throw new Error("Deferred maintenance task settlement owner is closed");
                    }
                  },
                  sessionKey,
                  runId,
                }),
              maintenance.signal,
            ),
          ),
        ),
      );
    } catch (error) {
      params.onScheduleFailure?.(error);
      cancelFailedTask(error);
    }
  };
  void (async () => {
    try {
      // Preparation descendants belong to maintenance, and must join before resource disposal.
      await params.runInContext(() => runContextEngineMaintenanceWork(run, maintenance.signal));
    } finally {
      try {
        await cleanupDeferredTurnMaintenance();
      } finally {
        try {
          while (pendingDisposals.size > 0) {
            await Promise.all(pendingDisposals);
          }
        } finally {
          schedulerAbort.dispose();
        }
      }
    }
  })().then(completion.resolve, completion.reject);
  return state.promise;
}

/**
 * Run optional context-engine transcript maintenance and normalize the result.
 */
export async function runContextEngineMaintenance(
  params: ContextEngineMaintenanceParams,
): Promise<ContextEngineMaintenanceResult | undefined> {
  const contextEngine = params.contextEngine;
  if (typeof contextEngine?.maintain !== "function") {
    return undefined;
  }

  // Caller memory cannot be reopened by a deferred worker. Keep its manager,
  // rewrite lock, and lifetime together even when background work is requested.
  const ownsMemoryTranscript =
    params.sessionManager !== undefined && params.sessionManager.getSessionTarget() === undefined;
  const executionMode = ownsMemoryTranscript
    ? "foreground"
    : (params.executionMode ?? "foreground");
  const shouldDefer =
    !ownsMemoryTranscript &&
    params.reason === "turn" &&
    executionMode !== "background" &&
    contextEngine.info.turnMaintenanceMode === "background";

  if (shouldDefer) {
    const releaseAdmission = retainGatewayRootWorkAdmissionContinuation();
    let deferred: Promise<void> | undefined;
    try {
      const sessionKey = normalizeOptionalString(params.sessionKey);
      if (!sessionKey) {
        params.onDeferredMaintenanceFailure?.(
          new Error("Deferred context-engine maintenance requires a session key"),
        );
        return undefined;
      }
      // The scheduler takes resource custody synchronously before the foreground transfer callback.
      deferred = scheduleDeferredTurnMaintenance({
        ...params,
        contextEngine,
        sessionKey,
        runInContext: AsyncLocalStorage.snapshot(),
        factoryResourceOwners: new Set(params.factoryResources ? [params.factoryResources] : []),
        disposeContextEngineAfterMaintenance: params.disposeDeferredContextEngineAfterMaintenance,
        onScheduleFailure: params.onDeferredMaintenanceFailure,
      });
      if (deferred) {
        params.onDeferredMaintenance?.(deferred);
      }
    } catch (err) {
      log.warn(`failed to schedule deferred context engine maintenance: ${String(err)}`);
    } finally {
      if (deferred && releaseAdmission) {
        // Each coalesced caller's captured context can still be used by reruns or disposal.
        // The shared completion owns release even if the transfer callback throws.
        void deferred.then(releaseAdmission, releaseAdmission);
      } else {
        releaseAdmission?.();
      }
    }
    return undefined;
  }

  try {
    return await executeContextEngineMaintenance({ ...params, contextEngine, executionMode });
  } catch (err) {
    params.abortSignal?.throwIfAborted();
    params.assertActive?.();
    log.warn(`context engine maintain failed (${params.reason}): ${String(err)}`);
    return undefined;
  }
}
