/** Process close owns every admitted model runtime and native catalog worker. */
import { writeSync } from "node:fs";
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
function traceShutdown(phase: string, count?: number) {
  if (!process.env.VITEST || process.env.OPENCLAW_GATEWAY_RESTART_TRACE !== "1") {
    return;
  }
  writeSync(2, `${JSON.stringify({ phase, count, pid: process.pid, time: Date.now() })}\n`);
}
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
  traceShutdown("model.close-callbacks.enter", lifetimes.closeCallbacks.size);
  void Promise.allSettled(
    [...lifetimes.closeCallbacks].map(async (close, index) => {
      traceShutdown("model.close-callback.enter", index);
      try {
        return await close(error);
      } finally {
        traceShutdown("model.close-callback.settled", index);
      }
    }),
  ).then(async (results) => {
    traceShutdown("model.close-callbacks.exit");
    try {
      traceShutdown("model.retire-plugins.enter");
      await lifetimes.retirePlugins?.();
      traceShutdown("model.retire-plugins.exit");
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

export function createPreparedModelRuntimeReplacement(): PreparedModelRuntimeReplacement {
  const { promise, resolve, reject } = createDeferredCore();
  // Readers await the original promise. This handler only prevents an unobserved rejected gate
  // when a reload fails before any request reaches the stale generation.
  void promise.catch(() => undefined);
  return { gateId: Symbol("prepared-model-runtime-replacement"), promise, resolve, reject };
}
