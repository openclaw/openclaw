import { AsyncLocalStorage } from "node:async_hooks";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import { AsyncContext } from "../../../shared/async-context.js";
import { createDeferredCore } from "../../../shared/deferred.js";

type CapacityWait = {
  run: () => Promise<void>;
  resume: () => void;
  reject: (error: unknown) => void;
};

type CapacityOwner = {
  active: boolean;
  outside: <T>(operation: () => Promise<T>) => Promise<T>;
};

const capacityOwner = new AsyncContext<CapacityOwner>(Symbol("executionCapacityOwner"));

/** Keep one task and its owners alive across separately admitted capacity tickets. */
export async function withReleasableExecutionCapacity<T>(
  enqueue: CommandQueueEnqueueFn,
  task: () => Promise<T>,
): Promise<T> {
  let suspended = createDeferredCore<CapacityWait>();
  let pending: CapacityWait | undefined;
  let running: Promise<T> | undefined;
  const owner: CapacityOwner = {
    active: false,
    outside: async <R>(operation: () => Promise<R>) => {
      if (!owner.active) {
        throw new Error("Execution capacity is not held");
      }
      owner.active = false;
      const continuation = createDeferredCore<R>();
      const context = AsyncLocalStorage.snapshot();
      let resume: () => void;
      suspended.resolve({
        run: async () => {
          try {
            const value = await context(operation);
            resume = () => continuation.resolve(value);
          } catch (error) {
            resume = () => continuation.reject(error);
          }
        },
        resume: () => resume(),
        reject: continuation.reject,
      });
      return continuation.promise;
    },
  };
  try {
    for (;;) {
      const result = await enqueue(async () => {
        suspended = createDeferredCore<CapacityWait>();
        owner.active = true;
        running ??= capacityOwner.run(owner, async () => task());
        pending?.resume();
        return await Promise.race([
          running.then((value) => ({ kind: "complete" as const, value })),
          suspended.promise.then((wait) => ({ kind: "suspended" as const, wait })),
        ]);
      });
      if (result.kind === "complete") {
        return result.value;
      }
      pending = result.wait;
      // Awaiting the ticket above also joins the queue's actual capacity release.
      await pending.run();
    }
  } catch (error) {
    owner.active = false;
    pending?.reject(error);
    await running?.catch(() => {});
    throw error;
  } finally {
    owner.active = false;
  }
}

/** Suspend only the designated wait; continuation and cleanup reacquire capacity. */
export function outsideExecutionCapacity<T>(operation: () => Promise<T>): Promise<T> {
  const owner = capacityOwner.getStore();
  return owner ? owner.outside(operation) : operation();
}
