import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createRetainedOperation, type RetainedOperation } from "./retained-operation.js";
import type {
  Slot,
  Task,
  RetainedWorkerTask,
  WorkerTaskResponse,
} from "./worker-task-pool.types.js";

export function dispatchOwnedWorkerRequest<Input, Output>(
  task: Task<Input, Output>,
  slot: Slot<Input, Output>,
  value: unknown,
  exchange: NonNullable<Task<Input, Output>["exchange"]>,
  owner: {
    accept: (response: WorkerTaskResponse) => void;
    reject: (error: unknown) => void;
    closedError: () => Error;
  },
): void {
  const context = { signal: task.controller.signal, yieldSignal: exchange.pressure.signal };
  const assertCurrent = () => {
    if (task.done || slot.task !== task) {
      throw owner.closedError();
    }
  };
  if (task.options.onRequestSync) {
    try {
      assertCurrent();
      owner.accept(task.options.onRequestSync(value, context));
    } catch (error) {
      owner.reject(error);
    }
    return;
  }
  void Promise.resolve()
    .then(() => {
      assertCurrent();
      return task.options.onRequest!(value, context);
    })
    .then(owner.accept)
    .catch(owner.reject);
}

export type OwnedWorkerTaskSettlement<Input, Output> = {
  cancel(task: Task<Input, Output>): void;
  detach(task: Task<Input, Output>): void;
  retire(slot: Slot<Input, Output>): RetainedOperation<void>;
  release(task: Task<Input, Output>, slot: Slot<Input, Output> | undefined): void;
};

export async function joinOwnedWorkerTasks(closures: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(closures);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Worker task cleanup failed");
  }
}

export function joinOwnedWorkerTask<Input, Output>(
  task: Task<Input, Output>,
  settlement: OwnedWorkerTaskSettlement<Input, Output>,
  retire = false,
): Promise<void> {
  return startJoinOwnedWorkerTask(task, settlement, retire).result;
}

function startJoinOwnedWorkerTask<Input, Output>(
  task: Task<Input, Output>,
  settlement: OwnedWorkerTaskSettlement<Input, Output>,
  retire = false,
): RetainedOperation<void> {
  const closing = startCloseOwnedWorkerTask(task, settlement, retire);
  const observe = () => {
    const outcome = closing.read();
    if (outcome.status === "pending") {
      return outcome;
    }
    // Automatic cleanup retains its admission charge until an explicit owner observes it.
    if (outcome.status === "rejected" && task.owner?.closing === closing) {
      task.owner.closing = undefined;
    }
    if (task.owner?.closed) {
      const slot = task.slot;
      task.slot = undefined;
      settlement.release(task, slot);
    }
    return outcome;
  };
  const result = closing.result.then(
    () => {
      observe();
    },
    (error: unknown) => {
      observe();
      throw error;
    },
  );
  void result.catch(() => undefined);
  return {
    result,
    read: observe,
    service() {
      closing.service();
      observe();
    },
  };
}

export function closeOwnedWorkerTask<Input, Output>(
  task: Task<Input, Output>,
  settlement: OwnedWorkerTaskSettlement<Input, Output>,
  retire = false,
): Promise<void> {
  return startCloseOwnedWorkerTask(task, settlement, retire).result;
}

function startCloseOwnedWorkerTask<Input, Output>(
  task: Task<Input, Output>,
  settlement: OwnedWorkerTaskSettlement<Input, Output>,
  retire = false,
): RetainedOperation<void> {
  const owner = task.owner;
  if (!owner || owner.closed) {
    if (owner?.closing) {
      return owner.closing;
    }
    const complete = createRetainedOperation<void>(() => {});
    complete.resolve();
    return complete.operation;
  }
  owner.retire ||= retire;
  if (owner.closing) {
    return owner.closing;
  }
  let retirement: RetainedOperation<void> | undefined;
  let observedPreparation: Promise<void> | undefined;
  let advancing = false;
  const closing = createRetainedOperation<void>(() => {
    retirement?.service();
    advance();
  });
  const advance = () => {
    if (advancing || closing.operation.read().status !== "pending") {
      return;
    }
    advancing = true;
    try {
      if (task.preparation) {
        if (observedPreparation !== task.preparation.promise) {
          observedPreparation = task.preparation.promise;
          void observedPreparation.then(advance, closing.reject);
        }
        return;
      }
      const slot = task.slot;
      if (slot && owner.retire) {
        if (!retirement) {
          retirement = settlement.retire(slot);
          void retirement.result.then(advance, advance);
        }
        const outcome = retirement.read();
        if (outcome.status === "pending") {
          return;
        }
        if (outcome.status === "rejected") {
          throw outcome.error;
        }
      }
      settlement.detach(task);
      try {
        owner.complete?.();
      } finally {
        owner.closed = true;
        owner.complete = undefined;
        task.input = undefined;
        task.options = {};
        task.abort = () => {};
      }
      closing.resolve();
    } catch (error) {
      closing.reject(error);
    } finally {
      advancing = false;
    }
  };
  owner.closing = closing.operation;
  if (!task.done) {
    settlement.cancel(task);
  }
  advance();
  return closing.operation;
}

export function retainWorkerTask<Input, Output>(
  task: Task<Input, Output>,
  settlement: OwnedWorkerTaskSettlement<Input, Output>,
  service: () => void,
): RetainedWorkerTask<Output> {
  return {
    result: task.promise,
    read: () => task.read(),
    service,
    release: (closeOptions) => {
      const closing = startJoinOwnedWorkerTask(task, settlement, closeOptions?.retire === true);
      return {
        result: closing.result,
        read: () => closing.read(),
        service: () => {
          service();
          closing.service();
        },
      };
    },
  };
}

export function prepareWorkerTaskInput<Input, Output>(
  task: Task<Input, Output>,
  receive: (input: Input) => void,
  reject: (error: unknown) => void,
  prepareResources?: () => Promise<unknown>,
): void {
  // Execution owns the input now; retaining it on task duplicates the worker's clone.
  const taskInput = task.input!;
  delete task.input;
  const preparation = Promise.withResolvers<void>();
  task.preparation = preparation;
  const finishPreparation = () => {
    preparation.resolve();
    if (task.preparation === preparation) {
      task.preparation = undefined;
    }
  };
  const failed = (error: unknown) => {
    finishPreparation();
    reject(error);
  };
  let prepared: Input | Promise<Input>;
  try {
    prepared =
      typeof taskInput === "function"
        ? (taskInput as () => Input | Promise<Input>)() // SAFETY: Callable inputs are factories.
        : taskInput;
  } catch (error) {
    failed(error);
    return;
  }
  if (prepareResources) {
    // Retain preparation custody until cleanup code is loaded, before creating artifacts.
    prepared = Promise.resolve(prepared).then(async (input) => {
      await prepareResources();
      return input;
    });
  }
  const ready = (input: Input) => {
    finishPreparation();
    receive(input);
  };
  if (isPromiseLike(prepared)) {
    void Promise.resolve(prepared).then(ready, failed);
  } else {
    ready(prepared);
  }
}

export function expireWorkerTasks<Input, Output>(
  queue: readonly Task<Input, Output>[],
  slots: ReadonlySet<Slot<Input, Output>>,
  expire: (task: Task<Input, Output>) => void,
): void {
  const now = performance.now();
  const pending = [...queue, ...[...slots].flatMap((slot) => (slot.task ? [slot.task] : []))];
  for (const task of pending) {
    if (!task.done && task.deadline !== undefined && now >= task.deadline) {
      expire(task);
    }
  }
}
