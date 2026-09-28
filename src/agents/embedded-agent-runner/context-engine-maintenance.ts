import { AsyncLocalStorage } from "node:async_hooks";
/**
 * Schedules and runs deferred context-engine turn maintenance.
 */
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
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createSessionMaintenanceOwner,
  waitForSessionMaintenance,
} from "../session-maintenance/coordinator.js";
import { executeContextEngineMaintenance } from "./context-engine-maintenance-execution.js";
import {
  disposeDeferredMaintenanceContextEngine,
  mergeContextEngineFactoryWork,
  runContextEngineMaintenanceWork,
  type ContextEngineMaintenanceResources,
} from "./context-engine-maintenance-work.js";
import type { ContextEngineMaintenanceParams } from "./context-engine-maintenance.types.js";
import { log } from "./logger.js";

const TURN_MAINTENANCE_LANE_PREFIX = "context-engine-turn-maintenance:";
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
  params: DeferredTurnMaintenanceScheduleParams & { abortSignal: AbortSignal },
): Promise<void> {
  try {
    await executeContextEngineMaintenance({ ...params, executionMode: "background" });
  } catch (error) {
    if (!isContextEngineAbortRejection(error, params.abortSignal)) {
      params.onDeferredMaintenanceFailure?.(error);
      log.warn("Deferred context engine maintenance failed: " + formatErrorMessage(error));
    }
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
  // Queue admission can synchronously schedule this session again.
  activeDeferredTurnMaintenanceRuns.set(sessionKey, state);
  const cleanupDeferredTurnMaintenance = () =>
    maintenance.run(async () => {
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
      const lane = `${TURN_MAINTENANCE_LANE_PREFIX}${sessionKey}`;
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
                  sessionKey,
                }),
              maintenance.signal,
            ),
          ),
        ),
      );
    } catch (error) {
      params.onScheduleFailure?.(error);
      log.warn(
        "Failed to schedule deferred context engine maintenance: " + formatErrorMessage(error),
      );
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
    try {
      const sessionKey = normalizeOptionalString(params.sessionKey);
      if (!sessionKey) {
        params.onDeferredMaintenanceFailure?.(
          new Error("Deferred context-engine maintenance requires a session key"),
        );
        return undefined;
      }
      // The scheduler takes resource custody synchronously before the foreground transfer callback.
      const deferred = scheduleDeferredTurnMaintenance({
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
