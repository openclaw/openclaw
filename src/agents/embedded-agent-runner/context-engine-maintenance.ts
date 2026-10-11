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
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createSessionMaintenanceOwner,
  waitForSessionMaintenance,
} from "../session-maintenance/coordinator.js";
import { executeContextEngineMaintenance } from "./context-engine-maintenance-execution.js";
import {
  disposeDeferredMaintenanceContextEngine,
  runContextEngineMaintenanceWork,
  type ContextEngineMaintenanceResources,
} from "./context-engine-maintenance-work.js";
import type { ContextEngineMaintenanceParams } from "./context-engine-maintenance.types.js";
import { log } from "./logger.js";

const TURN_MAINTENANCE_LANE_PREFIX = "context-engine-turn-maintenance:";

type DeferredTurnMaintenanceScheduleParams = ContextEngineMaintenanceParams & {
  contextEngine: ContextEngine;
  sessionKey: string;
  runInContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
  disposeContextEngineAfterMaintenance?: boolean;
  factoryResourceOwners: Set<ContextEngineMaintenanceResources>;
};

type DeferredTurnMaintenanceRunState = {
  maintenance: ReturnType<typeof createSessionMaintenanceOwner>;
  promise: Promise<void>;
  activeEngine: ContextEngine;
  pendingParams?: DeferredTurnMaintenanceScheduleParams;
  engines: DeferredTurnMaintenanceScheduleParams[];
  disposedEngines: WeakRef<ContextEngine>[];
  disposals: Set<Promise<void>>;
  closing: boolean;
};

const activeDeferredTurnMaintenanceRuns = new Map<string, DeferredTurnMaintenanceRunState>();

const maintenanceAbortControllers = new Set<AbortController>();
const maintenanceSignalHandlers = {
  SIGINT: () => abortDeferredMaintenance("SIGINT"),
  SIGTERM: () => abortDeferredMaintenance("SIGTERM"),
};

function unregisterDeferredTurnMaintenanceAbortSignalHandlers(): void {
  for (const [signal, handler] of Object.entries(maintenanceSignalHandlers)) {
    process.off(signal, handler);
  }
}

function abortDeferredMaintenance(signal: "SIGINT" | "SIGTERM"): void {
  const shouldReraise = process.listenerCount(signal) === 1;
  for (const controller of maintenanceAbortControllers) {
    controller.abort(new Error(`received ${signal} while waiting for deferred maintenance`));
  }
  maintenanceAbortControllers.clear();
  unregisterDeferredTurnMaintenanceAbortSignalHandlers();
  if (shouldReraise) {
    process.kill(process.pid, signal);
  }
}

function createDeferredTurnMaintenanceAbortSignal() {
  if (maintenanceAbortControllers.size === 0) {
    for (const [signal, handler] of Object.entries(maintenanceSignalHandlers)) {
      process.on(signal, handler);
    }
  }
  const controller = new AbortController();
  const abortSignal = AbortSignal.any([controller.signal, getGatewayRestartDrainSignal()]);
  maintenanceAbortControllers.add(controller);
  return {
    abortSignal,
    dispose: () => {
      maintenanceAbortControllers.delete(controller);
      if (maintenanceAbortControllers.size === 0) {
        unregisterDeferredTurnMaintenanceAbortSignalHandlers();
      }
    },
  };
}

function resetDeferredTurnMaintenanceStateForTest(): void {
  activeDeferredTurnMaintenanceRuns.clear();
  maintenanceAbortControllers.clear();
  unregisterDeferredTurnMaintenanceAbortSignalHandlers();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.contextEngineMaintenanceTestApi")
  ] = {
    resetDeferredTurnMaintenanceStateForTest,
  };
}

export async function waitForDeferredTurnMaintenanceForSession(sessionKey?: string): Promise<void> {
  await waitForSessionMaintenance(sessionKey);
}

function scheduleDeferredTurnMaintenance(
  params: DeferredTurnMaintenanceScheduleParams,
): Promise<void> | undefined {
  const { sessionKey } = params;
  if (isGatewayDraining()) {
    params.onDeferredMaintenanceFailure?.(new GatewayDrainingError());
    return undefined;
  }

  const activeRun = activeDeferredTurnMaintenanceRuns.get(sessionKey);
  if (activeRun) {
    if (activeRun.closing) {
      params.onDeferredMaintenanceFailure?.(
        new Error("Deferred maintenance is finishing cleanup; try again on the next turn"),
      );
      return undefined;
    }
    activeRun.disposedEngines = activeRun.disposedEngines.filter(
      (ref) => ref.deref() !== undefined,
    );
    if (
      activeRun.disposedEngines.some((ref) => {
        const engine = ref.deref();
        return engine !== undefined && hasSameContextEngineInstance(engine, params.contextEngine);
      })
    ) {
      params.onDeferredMaintenanceFailure?.(
        new Error("Context engine was disposed before deferred maintenance could be scheduled"),
      );
      return undefined;
    }
    const superseded = activeRun.pendingParams;
    activeRun.pendingParams = params;
    retainEngine(activeRun, params);
    if (
      superseded &&
      !hasSameContextEngineInstance(superseded.contextEngine, activeRun.activeEngine) &&
      !hasSameContextEngineInstance(superseded.contextEngine, params.contextEngine)
    ) {
      const disposal = disposeRetainedEngine(activeRun, superseded.contextEngine);
      activeRun.disposals.add(disposal);
      void disposal.finally(() => activeRun.disposals.delete(disposal));
    }
    return activeRun.promise;
  }

  const schedulerAbort = createDeferredTurnMaintenanceAbortSignal();
  const maintenance = createSessionMaintenanceOwner({
    sessionKey,
    abortSignal: schedulerAbort.abortSignal,
  });
  const completion = createDeferredCore();
  const state: DeferredTurnMaintenanceRunState = {
    maintenance,
    promise: maintenance.track(completion.promise),
    activeEngine: params.contextEngine,
    engines: [params],
    disposedEngines: [],
    disposals: new Set(),
    closing: false,
  };
  activeDeferredTurnMaintenanceRuns.set(sessionKey, state);
  const run = async () => {
    try {
      const lane = `${TURN_MAINTENANCE_LANE_PREFIX}${sessionKey}`;
      await enqueueCommandInLane(lane, () =>
        params.runInContext(() =>
          maintenance.run(async () => {
            let current: DeferredTurnMaintenanceScheduleParams | undefined = params;
            while (current && !maintenance.signal.aborted) {
              const request = current;
              state.activeEngine = request.contextEngine;
              await request.runInContext(() =>
                maintenance.run(() =>
                  runContextEngineMaintenanceWork(async () => {
                    const workerParams = {
                      ...request,
                      abortSignal: maintenance.signal,
                      assertActive: () => {
                        maintenance.assertCurrent();
                        request.assertActive?.();
                      },
                      sessionKey,
                    };
                    try {
                      await executeContextEngineMaintenance({
                        ...workerParams,
                        executionMode: "background",
                      });
                    } catch (error) {
                      if (!isContextEngineAbortRejection(error, workerParams.abortSignal)) {
                        workerParams.onDeferredMaintenanceFailure?.(error);
                        log.warn(
                          "Deferred context engine maintenance failed: " +
                            formatErrorMessage(error),
                        );
                      }
                    }
                  }, maintenance.signal),
                ),
              );
              current = state.pendingParams;
              state.pendingParams = undefined;
              state.activeEngine = current?.contextEngine ?? request.contextEngine;
              if (
                !current ||
                !hasSameContextEngineInstance(request.contextEngine, current.contextEngine)
              ) {
                await disposeRetainedEngine(state, request.contextEngine);
              }
              current = state.pendingParams ?? current;
              state.pendingParams = undefined;
            }
          }),
        ),
      );
    } catch (error) {
      params.onDeferredMaintenanceFailure?.(error);
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
        state.closing = true;
        while (state.engines.length > 0) {
          const engine = state.engines[0]!;
          await disposeRetainedEngine(state, engine.contextEngine);
        }
        await Promise.all(state.disposals);
      } finally {
        activeDeferredTurnMaintenanceRuns.delete(sessionKey);
        schedulerAbort.dispose();
      }
    }
  })().then(completion.resolve, completion.reject);
  return state.promise;
}

async function disposeRetainedEngine(
  state: DeferredTurnMaintenanceRunState,
  contextEngine: ContextEngine,
): Promise<void> {
  const index = state.engines.findIndex((entry) =>
    hasSameContextEngineInstance(entry.contextEngine, contextEngine),
  );
  if (index < 0) {
    return;
  }
  const [entry] = state.engines.splice(index, 1);
  if (entry?.disposeContextEngineAfterMaintenance) {
    state.disposedEngines = state.disposedEngines.filter((ref) => ref.deref() !== undefined);
    state.disposedEngines.push(new WeakRef(entry.contextEngine));
    await disposeDeferredMaintenanceContextEngine(entry, state.maintenance);
  }
}

function retainEngine(
  state: DeferredTurnMaintenanceRunState,
  params: DeferredTurnMaintenanceScheduleParams,
): void {
  const existing = state.engines.find((entry) =>
    hasSameContextEngineInstance(entry.contextEngine, params.contextEngine),
  );
  if (!existing) {
    state.engines.push(params);
    return;
  }
  existing.disposeContextEngineAfterMaintenance ||= params.disposeContextEngineAfterMaintenance;
  for (const resources of params.factoryResourceOwners) {
    existing.factoryResourceOwners.add(resources);
  }
}

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
