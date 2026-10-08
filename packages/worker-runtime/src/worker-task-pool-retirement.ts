import { AsyncLocalStorage } from "node:async_hooks";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createRetainedOperation, type RetainedOperation } from "./retained-operation.js";
import type { WorkerLifecycle } from "./worker-lifecycle.js";
import {
  serviceNativeWorkerPass,
  type WorkerTaskHost,
  type WorkerRetirementReason,
} from "./worker-task-host.js";
import {
  areWorkerNativeSectionsSettled,
  cancelWorkerNativeSections,
  waitForWorkerNativeSections,
} from "./worker-task-native-sections.js";
import type { Slot, WorkerTaskPoolOptions } from "./worker-task-pool.types.js";

const WORKER_WARM_WINDOW_MS = 5 * 60_000;

export function createWorkerTaskPoolRetirement<Input, Output>({
  slots,
  options,
  runInContext,
  dispatch,
  onRotationComplete,
  serviceDeadlines,
  markWorkerRetirement,
  serviceHost,
}: {
  slots: Set<Slot<Input, Output>>;
  options: WorkerTaskPoolOptions<Output>;
  runInContext: <T>(operation: () => T) => T;
  dispatch: () => void;
  onRotationComplete: () => void;
  serviceDeadlines: () => void;
  markWorkerRetirement: WorkerTaskHost["workerRetiring"];
  serviceHost: Pick<WorkerTaskHost, "serviceNativeWorkers">;
}) {
  const artifactCleanups = new Map<Promise<void>, RetainedOperation<void>>();
  let lastIdleRetirementAt = -Infinity;
  let warmSlot: Slot<Input, Output> | undefined;
  let rotation: RetainedOperation<void> | undefined;
  let rotationFailed = false;
  // Worker replies can arrive under an unrelated fake clock; use the owner's clock.
  const setTimeoutFn = setTimeout;
  const clearTimeoutFn = clearTimeout;
  const now = performance.now.bind(performance);
  const clearIdle = (slot: Slot<Input, Output>) => clearTimeoutFn(slot.idleTimer);

  function startRotate(): RetainedOperation<void> {
    if (rotation) {
      return rotation;
    }
    const runRotation = AsyncLocalStorage.snapshot();
    let retirements: RetainedOperation<void>[] | undefined;
    let artifacts: RetainedOperation<void> | undefined;
    let advancing = false;
    const completion = createRetainedOperation<void>(() => {
      serviceNativeWorkerPass(serviceHost, rotationSlots);
      serviceDeadlines();
      for (const retiring of retirements ?? []) {
        retiring.service();
      }
      artifacts?.service();
      advance();
    });
    rotation = completion.operation;
    rotationFailed = false;
    const rotationSlots = [...slots];
    const tasks = rotationSlots.flatMap((slot) => (slot.task ? [slot.task] : []));
    const advance = () =>
      runRotation(() => {
        if (advancing || completion.operation.read().status !== "pending") {
          return;
        }
        advancing = true;
        try {
          if (tasks.some((task) => task.read().status === "pending")) {
            return;
          }
          if (!retirements) {
            retirements = rotationSlots.map((slot) => startRetire(slot, "rotation"));
            for (const retiring of retirements) {
              void retiring.result.then(advance, advance);
            }
          }
          for (const retiring of retirements) {
            const stopped = retiring.read();
            if (stopped.status === "rejected") {
              throw stopped.error;
            }
            if (stopped.status === "pending") {
              return;
            }
          }
          if (!artifacts) {
            artifacts = startJoinArtifacts();
            void artifacts.result.then(advance, advance);
          }
          const cleaned = artifacts.read();
          if (cleaned.status === "pending") {
            return;
          }
          if (cleaned.status === "rejected") {
            throw cleaned.error;
          }
          rotation = undefined;
          onRotationComplete();
          completion.resolve();
          dispatch();
        } catch (error) {
          rotation = undefined;
          rotationFailed = true;
          completion.reject(error);
        } finally {
          advancing = false;
        }
      });
    for (const task of tasks) {
      void task.promise.then(advance, advance);
    }
    advance();
    return completion.operation;
  }

  function startRetire(
    slot: Slot<Input, Output>,
    reason: WorkerRetirementReason = "closed",
  ): RetainedOperation<void> {
    if (reason === "idle_timeout") {
      lastIdleRetirementAt = now();
    } else if (reason === "rotation") {
      lastIdleRetirementAt = -Infinity;
    }
    if (warmSlot === slot) {
      warmSlot = undefined;
    }
    if (slot.worker) {
      markWorkerRetirement(slot.worker, reason);
    }
    clearIdle(slot);
    cancelWorkerNativeSections(slot.nativeSections);
    if (slot.retiring) {
      return slot.retiring;
    }
    const runRetirement = AsyncLocalStorage.snapshot();
    let nativeStop: RetainedOperation<void> | undefined;
    let observingSection = false;
    let advancing = false;
    const completion = createRetainedOperation<void>(() => {
      nativeStop?.service();
      advance();
    });
    const advance = () =>
      runRetirement(() => {
        if (advancing || completion.operation.read().status !== "pending") {
          return;
        }
        advancing = true;
        try {
          if (slot.creating) {
            return;
          }
          if (!areWorkerNativeSectionsSettled(slot.nativeSections)) {
            if (!observingSection) {
              observingSection = true;
              void Promise.resolve(waitForWorkerNativeSections(slot.nativeSections)).then(
                advance,
                completion.reject,
              );
            }
            return;
          }
          if (slot.worker && !nativeStop) {
            markWorkerRetirement(slot.worker, reason);
            if (slot.native) {
              nativeStop = slot.native.stop();
            } else {
              const stopped = createRetainedOperation<void>(() => {});
              nativeStop = stopped.operation;
              // Direct SDK Workers retain their existing awaited native barrier.
              void Promise.resolve()
                .then(() => slot.worker!.terminate())
                .then(() => stopped.resolve(), stopped.reject);
            }
            void nativeStop.result.then(advance, advance);
          }
          const stopped = nativeStop?.read();
          if (stopped?.status === "pending") {
            return;
          }
          if (stopped?.status === "rejected") {
            throw stopped.error;
          }
          slot.retired = true;
          const releaseResources = slot.releaseResources;
          if (releaseResources) {
            runInContext(() => {
              const cleanup = (async () => {
                try {
                  await releaseResources();
                } catch (error) {
                  try {
                    process.emitWarning(`Worker task resource release failed: ${String(error)}`);
                  } catch {
                    // Warning sinks cannot replace the task's original outcome.
                  }
                }
              })();
              // Release execution capacity at exit; terminal close still joins disposable files.
              const settled = createRetainedOperation<void>(() => {});
              artifactCleanups.set(cleanup, settled.operation);
              void cleanup.then(() => {
                artifactCleanups.delete(cleanup);
                settled.resolve();
              }, settled.reject);
            });
          }
          slot.worker?.removeAllListeners();
          slots.delete(slot);
          for (const complete of slot.completions ?? []) {
            complete();
          }
          slot.completions = undefined;
          dispatch();
          completion.resolve();
        } catch (error) {
          try {
            void Promise.resolve(options.onRetirementFailure?.(error)).catch(() => undefined);
          } catch {
            // Observer failures cannot replace native custody or its original failure.
          }
          // Keep native custody and queued input charges until a later close/rotation joins exit.
          slot.retirementFailed = true;
          slot.retiring = undefined;
          completion.reject(error);
        } finally {
          advancing = false;
        }
      });
    slot.retiring = completion.operation;
    // Constructor observers may retire before the returned Worker is installed.
    void Promise.resolve().then(advance);
    return completion.operation;
  }

  function retire(slot: Slot<Input, Output>, reason?: WorkerRetirementReason): Promise<void> {
    return startRetire(slot, reason).result;
  }

  function startJoinArtifacts(): RetainedOperation<void> {
    const pending = [...artifactCleanups.values()];
    const joined = createRetainedOperation<void>(() => {
      for (const operation of pending) {
        operation.service();
      }
      advance();
    });
    const advance = () => {
      const outcomes = pending.map((operation) => operation.read());
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") {
        joined.reject(failure.error);
      } else if (outcomes.every((outcome) => outcome.status === "fulfilled")) {
        joined.resolve();
      }
    };
    for (const operation of pending) {
      void operation.result.then(advance, advance);
    }
    advance();
    return joined.operation;
  }

  /** Join failed native retirements without interrupting healthy tasks. */
  async function retryFailedRetirements(): Promise<void> {
    const outcomes = await Promise.allSettled(
      [...slots].filter((slot) => slot.retirementFailed).map((slot) => retire(slot)),
    );
    outcomes.push(...(await Promise.allSettled(artifactCleanups.keys())));
    const errors = outcomes.flatMap((outcome) =>
      outcome.status === "rejected"
        ? [toErrorObject(outcome.reason, "worker retirement retry failed")]
        : [],
    );
    const firstError = errors[0];
    if (firstError) {
      throw errors.length === 1
        ? firstError
        : new AggregateError(errors, "Worker retirement retries failed", { cause: firstError });
    }
  }

  return {
    get dispatchAllowed() {
      return rotation === undefined && !rotationFailed;
    },
    startRotate,
    retire,
    startRetire,
    service() {
      const current = [...slots];
      for (const slot of current) {
        slot.retiring?.service();
      }
      rotation?.service();
    },
    clearIdle,
    idle(slot: Slot<Input, Output>) {
      const idleMs = options.idleTimeoutMs ?? 60_000;
      if (idleMs <= 0) {
        return;
      }
      // A promptly reused pool retains one isolate; excess slots keep their normal timeout.
      if (!warmSlot && now() - lastIdleRetirementAt < WORKER_WARM_WINDOW_MS) {
        warmSlot = slot;
      }
      slot.idleTimer = runInContext(() =>
        setTimeoutFn(
          () => void retire(slot, "idle_timeout").catch(() => undefined),
          warmSlot === slot ? Math.max(idleMs, WORKER_WARM_WINDOW_MS) : idleMs,
        ),
      );
      slot.idleTimer.unref();
    },
    retireIdle(resourceClosures: WeakMap<WorkerLifecycle, { pending: number }>) {
      for (const slot of slots) {
        if (
          !slot.task &&
          !slot.retiring &&
          !slot.retirementFailed &&
          slot.worker &&
          !resourceClosures.get(slot.worker)?.pending
        ) {
          void retire(slot, "memory_pressure").catch(() => undefined);
        }
      }
    },
    retryFailedRetirements,
    joinArtifacts: () => startJoinArtifacts().result,
  };
}
