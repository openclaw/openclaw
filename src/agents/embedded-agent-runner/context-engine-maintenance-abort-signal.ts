/**
 * Process-signal abort machinery for deferred context-engine turn maintenance.
 * A single shared abort state per process ties every in-flight deferred run to
 * SIGINT/SIGTERM so a shutdown aborts outstanding waits and re-raises the
 * signal once no run remains registered.
 */
const DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY = Symbol.for(
  "openclaw.contextEngineTurnMaintenanceAbortState",
);

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

export function createDeferredTurnMaintenanceAbortSignal(params?: {
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

/**
 * Clear the process-level abort state so a test starts from a clean slate.
 * Complements the scheduler-owned run map reset, which lives with that map.
 */
export function resetDeferredTurnMaintenanceAbortStateForTest(): void {
  const processLike = process as DeferredTurnMaintenanceProcessLike;
  const state = processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY];
  if (!state) {
    return;
  }
  state.controllers.clear();
  unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
  delete processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY];
}
