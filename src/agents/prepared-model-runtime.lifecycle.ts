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
}

type ModelRuntimeClose = (error: Error) => Promise<void>;
class ProcessModelRuntimeLifetimes {
  readonly closeCallbacks = new Set<ModelRuntimeClose>();
  retirePlugins?: () => Promise<void>;
  epoch = 0;
  closing?: Promise<void>;
  failedClose?: {
    error: Error;
    callbacks: ModelRuntimeClose[];
    retirePlugins?: () => Promise<void>;
  };
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
  // Failed cleanup keeps admission fenced; only its still-owned work can be retried.
  const retry = lifetimes.failedClose;
  if (lifetimes.closing && !retry) {
    return lifetimes.closing;
  }
  const closed = createDeferredCore();
  lifetimes.closing = closed.promise;
  lifetimes.failedClose = undefined;
  if (!retry) {
    lifetimes.epoch += 1;
  }
  const error = retry?.error ?? new Error("prepared model runtime process lifetime closed");
  const callbacks = retry
    ? retry.callbacks.filter((close) => lifetimes.closeCallbacks.has(close))
    : [...lifetimes.closeCallbacks];
  void Promise.allSettled(callbacks.map(async (close) => await close(error))).then(
    async (results) => {
      const failedCallbacks = callbacks.filter((_, index) => results[index]?.status === "rejected");
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      const retirePlugins = retry
        ? retry.retirePlugins === lifetimes.retirePlugins
          ? retry.retirePlugins
          : undefined
        : lifetimes.retirePlugins;
      let failedRetirement: typeof retirePlugins = undefined;
      try {
        await retirePlugins?.();
        if (lifetimes.retirePlugins === retirePlugins) {
          lifetimes.retirePlugins = undefined;
        }
      } catch (reason) {
        failedRetirement = retirePlugins;
        failures.push(reason);
      }
      if (failures.length) {
        lifetimes.failedClose = {
          error,
          callbacks: failedCallbacks,
          retirePlugins: failedRetirement,
        };
        closed.reject(new AggregateError(failures, "Prepared model runtime failed to close"));
      } else {
        lifetimes.closing = undefined;
        closed.resolve();
      }
    },
  );
  return closed.promise;
}

export function createPreparedModelRuntimeReplacement(): PreparedModelRuntimeReplacement {
  const { promise, resolve, reject } = createDeferredCore();
  // Readers await the original promise. This handler only prevents an unobserved rejected gate
  // when a reload fails before any request reaches the stale generation.
  void promise.catch(() => undefined);
  return { gateId: Symbol("prepared-model-runtime-replacement"), promise, resolve, reject };
}
