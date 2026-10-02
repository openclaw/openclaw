import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

type RuntimeOwner = object;

type InitializingState = {
  phase: "initializing";
  config: SandboxRuntimeConfig;
  promise: Promise<void>;
  cleanupFailed: boolean;
};

type ResettingState = {
  phase: "resetting";
  promise: Promise<void>;
};

type RuntimeState =
  | { phase: "idle" }
  | InitializingState
  | { phase: "ready"; config: SandboxRuntimeConfig }
  | ResettingState
  | { phase: "faulted"; error: unknown };

let state: RuntimeState = { phase: "idle" };
const owners = new Set<RuntimeOwner>();

function currentState(): RuntimeState {
  return state;
}

function ownershipConflict(): Error {
  return new Error(
    "srt-sandbox: the process-global SRT runtime is already owned outside this plugin; " +
      "concurrent SRT owners are unsupported",
  );
}

function teardownInProgress(): Error {
  return new Error("srt-sandbox: runtime admission rejected while shutdown is in progress");
}

function assertRuntimeReady(config: SandboxRuntimeConfig): void {
  if (
    !SandboxManager.isSandboxingEnabled() ||
    SandboxManager.getConfig() !== config ||
    typeof SandboxManager.getProxyPort() !== "number"
  ) {
    throw new Error("srt-sandbox: SRT initialization completed without a live owned runtime");
  }
}

function beginInitialization(config: SandboxRuntimeConfig): InitializingState {
  const initializing: InitializingState = {
    phase: "initializing",
    config,
    promise: Promise.resolve(),
    cleanupFailed: false,
  };
  state = initializing;
  initializing.promise = (async () => {
    // SRT 0.0.76 intentionally leaves its config behind after reset(), so
    // isSandboxingEnabled()/getConfig() alone cannot distinguish a live owner
    // from retired state. A live initialized runtime always owns a proxy port.
    if (typeof SandboxManager.getProxyPort() === "number") {
      throw ownershipConflict();
    }
    try {
      await SandboxManager.initialize(config);
      assertRuntimeReady(config);
    } catch (initializationError) {
      try {
        await SandboxManager.reset();
      } catch (cleanupError) {
        initializing.cleanupFailed = true;
        const combinedError = new AggregateError(
          [initializationError, cleanupError],
          "srt-sandbox: initialization and cleanup both failed",
          { cause: initializationError },
        );
        throw combinedError;
      }
      throw initializationError;
    }
  })();
  return initializing;
}

function beginReset(
  initialization?: Promise<void>,
  beforeReset?: () => Promise<void>,
): Promise<void> {
  if (state.phase === "resetting") {
    return state.promise;
  }
  const resetting: ResettingState = { phase: "resetting", promise: Promise.resolve() };
  state = resetting;
  resetting.promise = (async () => {
    await beforeReset?.();
    owners.clear();
    await initialization?.catch(() => undefined);
    await SandboxManager.reset();
  })().then(
    () => {
      if (state === resetting) {
        state = { phase: "idle" };
      }
    },
    (error: unknown) => {
      if (state === resetting) {
        state = { phase: "faulted", error };
      }
      throw error;
    },
  );
  return resetting.promise;
}

/**
 * Acquire one scope's lease on SRT's process-global runtime.
 *
 * SRT 0.0.76 has no ownership API. This coordinator therefore requires
 * exclusive ownership: it rejects a runtime that was initialized elsewhere,
 * refcounts every admitted plugin scope, and is the only plugin path allowed to
 * call reset(). New admissions fail closed for the full reset interval.
 */
export async function acquireSrtRuntime(
  owner: RuntimeOwner,
  config: SandboxRuntimeConfig,
): Promise<void> {
  if (owners.has(owner)) {
    return;
  }
  if (state.phase === "resetting") {
    throw teardownInProgress();
  }
  if (state.phase === "faulted") {
    throw new Error("srt-sandbox: runtime cleanup failed; shutdown must succeed before retry", {
      cause: state.error,
    });
  }

  const initializing = state.phase === "idle" ? beginInitialization(config) : state;
  if (initializing.phase === "initializing") {
    try {
      await initializing.promise;
    } catch (error) {
      if (state === initializing) {
        state = initializing.cleanupFailed ? { phase: "faulted", error } : { phase: "idle" };
      }
      throw error;
    }
    const settledState = currentState();
    if (settledState.phase === "resetting") {
      throw teardownInProgress();
    }
    if (settledState === initializing) {
      state = { phase: "ready", config: initializing.config };
    }
  }

  const readyState = currentState();
  if (readyState.phase !== "ready") {
    throw teardownInProgress();
  }
  assertRuntimeReady(readyState.config);
  owners.add(owner);
}

/** Release one scope; only the final owner retires the global SRT runtime. */
export async function releaseSrtRuntime(owner: RuntimeOwner): Promise<void> {
  if (!owners.delete(owner)) {
    return;
  }
  if (owners.size > 0 || state.phase === "idle") {
    return;
  }
  // A plugin-wide shutdown has already claimed reset ownership. It will wait
  // for initialization and reset after every scope has disposed its children.
  if (state.phase === "resetting") {
    return;
  }
  await beginReset(state.phase === "initializing" ? state.promise : undefined);
}

/**
 * Claim teardown ownership immediately, rejecting admissions until reset has
 * completely settled. Concurrent callers share the same reset operation.
 */
export function shutdownSrtRuntime(
  disposeOwners: () => Promise<void>,
  forceReset = false,
): Promise<void> {
  if (state.phase === "resetting") {
    return state.promise;
  }
  if (state.phase === "idle" && owners.size === 0 && !forceReset) {
    return Promise.resolve();
  }
  const initialization = state.phase === "initializing" ? state.promise : undefined;
  return beginReset(initialization, disposeOwners);
}
