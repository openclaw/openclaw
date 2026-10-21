/** Serializes run-owned transcript callbacks and bounds teardown settlement. */
import { AsyncLocalStorage } from "node:async_hooks";
import { toErrorObject } from "../../../infra/errors.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { settlesWithin } from "../../../shared/settle-within.js";
import { log } from "../logger.js";

const TRANSCRIPT_TEARDOWN_BUDGET_MS = 30_000;

type LifecycleOwner = {
  readonly attempt: symbol;
  readonly parent: LifecycleOwner | undefined;
  active: boolean;
  nestedTail: Promise<void>;
  pendingOperations: Set<Promise<void>>;
};

const lifecycleOwners = new AsyncLocalStorage<LifecycleOwner>();

export type EmbeddedAttemptTranscriptLifecycle = {
  withTranscriptWrite<T>(run: () => Promise<T> | T): Promise<T>;
  /** Retire callbacks after the actual drain, including when owner release fails. */
  beginCleanup(onDrained?: () => void): Promise<void>;
  dispose(): Promise<void>;
};

export function createEmbeddedAttemptTranscriptLifecycle(params: {
  runId?: string;
  sessionId?: string;
  /** Release retained owners after accepted descendants settle, even after a teardown timeout. */
  onDrained?: () => void | Promise<void>;
}): EmbeddedAttemptTranscriptLifecycle {
  let disposed = false;
  let lifecycle = Promise.resolve();
  let cleanupDrain: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  let pendingWrites = 0;
  const attempt = Symbol("transcript-attempt");
  // Writes may enter another attempt's lifecycle before re-entering this one.
  const currentOwner = (): LifecycleOwner | undefined => {
    for (let owner = lifecycleOwners.getStore(); owner; owner = owner.parent) {
      if (owner.attempt === attempt) {
        return owner;
      }
    }
    return undefined;
  };

  const createLifecycleOwner = (): LifecycleOwner => ({
    attempt,
    parent: lifecycleOwners.getStore(),
    active: true,
    nestedTail: Promise.resolve(),
    pendingOperations: new Set(),
  });
  const drainLifecycleOwner = async (owner: LifecycleOwner): Promise<void> => {
    let firstError: Error | undefined;
    while (owner.pendingOperations.size > 0) {
      const pending = [...owner.pendingOperations];
      owner.pendingOperations.clear();
      const settled = await Promise.allSettled(pending);
      const rejected = settled.find((result) => result.status === "rejected");
      if (firstError === undefined && rejected?.status === "rejected") {
        firstError = toErrorObject(rejected.reason, "nested transcript write failed");
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  };
  const runLifecycleOwner = async <T>(
    owner: LifecycleOwner,
    run: () => Promise<T> | T,
  ): Promise<T> => {
    let value: T | undefined;
    let primaryError: Error | undefined;
    try {
      value = await lifecycleOwners.run(owner, async () => await run());
    } catch (error) {
      primaryError = toErrorObject(error, "transcript write failed");
    }
    let drainError: Error | undefined;
    try {
      await drainLifecycleOwner(owner);
    } catch (error) {
      drainError = toErrorObject(error, "nested transcript drain failed");
    } finally {
      owner.active = false;
    }
    if (
      primaryError !== undefined &&
      drainError !== undefined &&
      drainError !== primaryError &&
      primaryError.cause === undefined
    ) {
      try {
        primaryError.cause = drainError;
      } catch {
        // Frozen callback errors remain primary; drain failure is secondary.
      }
    }
    const failure = primaryError ?? drainError;
    if (failure !== undefined) {
      throw failure;
    }
    return value as T;
  };
  const serializeLifecycle = async <T>(run: () => Promise<T> | T): Promise<T> => {
    const inheritedOwner = currentOwner();
    if (inheritedOwner?.active) {
      const operation = inheritedOwner.nestedTail.then(
        async () => await runLifecycleOwner(createLifecycleOwner(), run),
      );
      inheritedOwner.nestedTail = operation.then(
        () => undefined,
        () => undefined,
      );
      const propagated = operation.then(() => undefined);
      void propagated.catch(() => {});
      inheritedOwner.pendingOperations.add(propagated);
      return await operation;
    }

    const previous = lifecycle;
    const { promise, resolve: release } = createDeferredCore();
    lifecycle = promise;
    await previous;
    const owner = createLifecycleOwner();
    try {
      return await runLifecycleOwner(owner, run);
    } finally {
      release();
    }
  };
  const settleWithinTeardownBudget = async (operation: Promise<void>): Promise<void> => {
    if (!(await settlesWithin(operation, TRANSCRIPT_TEARDOWN_BUDGET_MS))) {
      log.error(
        `transcript teardown budget expired: runId=${params.runId ?? "unknown"} ` +
          `sessionId=${params.sessionId ?? "unknown"} pendingWrites=${pendingWrites} ` +
          `timeoutMs=${TRANSCRIPT_TEARDOWN_BUDGET_MS}`,
      );
    }
  };
  const beginCleanup = async (onDrained?: () => void): Promise<void> => {
    if (currentOwner()?.active) {
      throw new Error("cannot start attempt cleanup inside a transcript write callback");
    }
    // Accepted descendants retain their owner until the drain settles, even when
    // the bounded teardown budget expires. Cleanup never disables the shared carrier.
    cleanupDrain ??= settleWithinTeardownBudget(
      serializeLifecycle(async () => {
        currentOwner()!.active = false;
        try {
          await params.onDrained?.();
        } finally {
          onDrained?.();
        }
      }),
    );
    await cleanupDrain;
  };

  return {
    withTranscriptWrite: (run) => {
      const activeDescendant = currentOwner()?.active === true;
      if ((cleanupDrain || disposed) && !activeDescendant) {
        const rejected = Promise.reject(
          new Error(
            disposed
              ? "attempt disposed before transcript write"
              : "attempt cleanup started before transcript write",
          ),
        );
        void rejected.catch(() => {});
        return rejected;
      }
      pendingWrites += 1;
      const operation = serializeLifecycle(run);
      void operation
        .finally(() => {
          pendingWrites -= 1;
        })
        .catch(() => {});
      return operation;
    },
    beginCleanup,
    dispose: async () => {
      if (currentOwner()?.active) {
        throw new Error("cannot dispose an attempt from inside a transcript write callback");
      }
      disposePromise ??= (async () => {
        await beginCleanup();
        disposed = true;
      })();
      await disposePromise;
    },
  };
}
