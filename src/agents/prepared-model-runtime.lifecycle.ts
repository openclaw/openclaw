/** Process close owns every admitted model runtime and native catalog worker. */
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeReplacement,
} from "./prepared-model-runtime.types.js";

/** Notifications supplement the owner's generation and registration checks. */
export function capturePreparedModelRuntimeGeneration(
  owner: Pick<PreparedModelRuntimeOwner, "generationRetirement">,
): AbortSignal {
  return (owner.generationRetirement ??= new AbortController()).signal;
}

export function retirePreparedModelRuntimeGeneration(
  owner: Pick<PreparedModelRuntimeOwner, "generationRetirement">,
): void {
  const retirement = owner.generationRetirement;
  owner.generationRetirement = undefined;
  retirement?.abort();
  if (retirement?.signal.reason instanceof Error) {
    // Retained signals must not keep the retiring caller's lazy stack frames alive.
    void retirement.signal.reason.stack;
  }
}

type ModelRuntimeClose = (error: Error) => Promise<void>;
class ProcessModelRuntimeLifetimes {
  readonly closeCallbacks = new Set<ModelRuntimeClose>();
  retirePlugins?: () => Promise<void>;
  epoch = 0;
  closing?: Promise<void>;
}

const lifetimes = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedModelRuntimeLifetimes"),
  () => new ProcessModelRuntimeLifetimes(),
  () => closePreparedModelRuntimeSnapshots(),
);

export function capturePreparedModelRuntimeLifetime(): () => void {
  const epoch = lifetimes.epoch;
  const assertCurrent = () => {
    if (lifetimes.closing || epoch !== lifetimes.epoch) {
      throw new Error("prepared model runtime process lifetime closed");
    }
  };
  assertCurrent();
  return assertCurrent;
}

export function registerPreparedModelRuntimeClose(close: ModelRuntimeClose): () => void {
  capturePreparedModelRuntimeLifetime();
  lifetimes.closeCallbacks.add(close);
  return () => lifetimes.closeCallbacks.delete(close);
}

/** Install the shared plugin resource owner only when a real generation acquires it. */
export function registerPreparedPluginRetirement(retire: () => Promise<void>): void {
  capturePreparedModelRuntimeLifetime();
  lifetimes.retirePlugins ??= retire;
}

/** Fence admission before abort callbacks run; old publications cannot enter the next lifetime. */
export function closePreparedModelRuntimeSnapshots(): Promise<void> {
  if (lifetimes.closing) {
    return lifetimes.closing;
  }
  const closed = createDeferredCore();
  lifetimes.closing = closed.promise;
  lifetimes.epoch += 1;
  const error = new Error("prepared model runtime process lifetime closed");
  void Promise.allSettled(
    [...lifetimes.closeCallbacks].map(async (close) => await close(error)),
  ).then(async (results) => {
    try {
      await lifetimes.retirePlugins?.();
      lifetimes.retirePlugins = undefined;
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      closed.reject(new AggregateError(failures, "Prepared model runtime failed to close"));
    } else {
      lifetimes.closing = undefined;
      closed.resolve();
    }
  });
  return closed.promise;
}

export function createPreparedModelRuntimeReplacement(
  agentIds?: ReadonlySet<string>,
): PreparedModelRuntimeReplacement {
  const { promise, resolve, reject } = createDeferredCore();
  // Readers await the original promise. This handler only prevents an unobserved rejected gate
  // when a reload fails before any request reaches the stale generation.
  void promise.catch(() => undefined);
  return {
    agentIds,
    gateId: Symbol("prepared-model-runtime-replacement"),
    promise,
    resolve,
    reject,
  };
}

/** Execution waits for plugin replacement while the active publication remains readable. */
export function createPreparedModelRuntimePluginDrain(
  getCancellationSignal: () => AbortSignal,
  hasPendingPublication: () => boolean,
) {
  let pending: PreparedModelRuntimeReplacement | undefined;
  return {
    get pending() {
      return pending;
    },
    begin: () => {
      capturePreparedModelRuntimeLifetime();
      getCancellationSignal().throwIfAborted();
      if (pending) {
        throw new Error("Prepared model runtime plugin drain is already pending");
      }
      const drain = createPreparedModelRuntimeReplacement();
      pending = drain;
      const unregister = registerPreparedModelRuntimeClose(async (error) => {
        unregister();
        if (pending === drain) {
          pending = undefined;
        }
        drain.reject(error);
      });
      return {
        pendingPublication: hasPendingPublication(),
        release: () => {
          unregister();
          if (pending === drain) {
            pending = undefined;
            drain.resolve();
          }
        },
      };
    },
    async runAfter(
      queue: { enqueue: (task: () => Promise<void>) => Promise<void> },
      run: () => Promise<void>,
    ): Promise<void> {
      const assertCurrent = capturePreparedModelRuntimeLifetime();
      for (;;) {
        const reservation = pending;
        if (reservation) {
          await reservation.promise;
          continue;
        }
        assertCurrent();
        let started = false;
        await queue.enqueue(async () => {
          assertCurrent();
          if (pending) {
            return;
          }
          started = true;
          await run();
        });
        if (started) {
          return;
        }
        // A newer reservation must release the queue before waiting for its drain.
      }
    },
  };
}
