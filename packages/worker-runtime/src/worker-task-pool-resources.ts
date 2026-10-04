import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createRetainedOperation, type RetainedOperation } from "./retained-operation.js";
import type { WorkerLifecycle } from "./worker-lifecycle.js";
import type { Slot, WorkerTaskPoolOwnerOptions } from "./worker-task-pool.types.js";

export type WorkerResourceClosures = {
  pending: number;
  exit?: { waiters: Set<() => void>; receive: () => void };
};

/** Each existing slot retains its cleanup receipt; no result Promise controls custody. */
export function startCloseWorkerPoolResources<Input, Output>(
  slots: ReadonlySet<Slot<Input, Output>>,
  resourceClosures: WeakMap<WorkerLifecycle, WorkerResourceClosures>,
  retire: (slot: Slot<Input, Output>) => RetainedOperation<void>,
  key?: string,
  options?: WorkerTaskPoolOwnerOptions,
): RetainedOperation<void> {
  const operations = [...slots].map((slot) => {
    if (slot.retiring) {
      return slot.retiring;
    }
    if (slot.native?.executionStopped) {
      return retire(slot);
    }
    const worker = slot.worker;
    if (!worker) {
      const complete = createRetainedOperation<void>(() => {});
      complete.resolve();
      return complete.operation;
    }
    const closure = resourceClosures.get(worker) ?? { pending: 0 };
    closure.pending++;
    resourceClosures.set(worker, closure);
    worker.ref();
    return startCloseWorkerTaskResources(slot, worker, closure, key, options, retire);
  });
  const completion = createRetainedOperation<void>(() => {
    for (const operation of operations) {
      operation.service();
    }
    advance();
  });
  const advance = () => {
    const outcomes = operations.map((operation) => operation.read());
    if (outcomes.some((outcome) => outcome.status === "pending")) {
      return;
    }
    const errors = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.error] : [],
    );
    if (errors.length) {
      completion.reject(new AggregateError(errors, "Worker resource cleanup failed"));
    } else {
      completion.resolve();
    }
  };
  for (const operation of operations) {
    void operation.result.then(advance, advance);
  }
  advance();
  return completion.operation;
}

/** Concurrent resource closes share one listener until their last real receipt. */
function observeResourceWorkerExit(
  worker: WorkerLifecycle,
  closures: WorkerResourceClosures,
  finish: () => void,
): () => void {
  let exit = closures.exit;
  if (!exit) {
    const waiters = new Set<() => void>();
    exit = {
      waiters,
      receive: () => {
        for (const waiter of waiters) {
          waiter();
        }
      },
    };
    closures.exit = exit;
    worker.once("exit", exit.receive);
  }
  exit.waiters.add(finish);
  return () => {
    exit.waiters.delete(finish);
    if (!exit.waiters.size) {
      worker.removeListener("exit", exit.receive);
      if (closures.exit === exit) {
        closures.exit = undefined;
      }
    }
  };
}

function startCloseWorkerTaskResources<Input, Output>(
  slot: Slot<Input, Output>,
  worker: WorkerLifecycle,
  closures: WorkerResourceClosures,
  key: string | undefined,
  options: WorkerTaskPoolOwnerOptions | undefined,
  retire: (slot: Slot<Input, Output>) => RetainedOperation<void>,
): RetainedOperation<void> {
  const { port1, port2 } = new MessageChannel();
  const runInContext = AsyncLocalStorage.snapshot();
  let settled = false;
  let awaitingRetirement = false;
  let selectedRetirement: RetainedOperation<void> | undefined;
  const completion = createRetainedOperation<void>(() => {
    if (settled) {
      return;
    }
    slot.native?.service();
    if (slot.native?.executionStopped) {
      awaitingRetirement = true;
      selectedRetirement ??= slot.retiring ?? retire(slot);
    }
    for (;;) {
      const next = receiveMessageOnPort(port1);
      if (!next || settled) {
        break;
      }
      receive(next.message);
    }
    const retirement = selectedRetirement ?? slot.retiring;
    if (awaitingRetirement && retirement) {
      retirement.service();
      const stopped = retirement.read();
      if (stopped.status === "fulfilled") {
        finish();
      } else if (stopped.status === "rejected") {
        finish(toErrorObject(stopped.error, "Worker resource cleanup retirement failed"));
      }
    }
  });
  const finish = (error?: Error) =>
    runInContext(() => {
      if (settled) {
        return;
      }
      settled = true;
      stopObservingExit();
      port1.close();
      port2.close();
      closures.pending--;
      if (!closures.pending && !slot.task && !slot.retiring) {
        worker.unref();
      }
      if (error) {
        completion.reject(error);
      } else {
        completion.resolve();
      }
    });
  const receive = (reply: unknown) => {
    try {
      if (isRecord(reply) && reply.ok === true) {
        finish();
        return;
      }
      const error =
        isRecord(reply) && reply.detail !== undefined && options?.decodeResourceError
          ? options.decodeResourceError(reply.detail)
          : new Error(
              isRecord(reply) && typeof reply.error === "string"
                ? reply.error
                : "Invalid worker resource cleanup receipt",
            );
      finish(error);
    } catch (error) {
      finish(toErrorObject(error, "Worker resource cleanup receipt could not be decoded"));
    }
  };
  const stopObservingExit = observeResourceWorkerExit(worker, closures, () => finish());
  port1.once("message", receive);
  port1.once("messageerror", (error) =>
    finish(toErrorObject(error, "Worker resource cleanup receipt could not be decoded")),
  );
  port1.once("close", () => {
    if (settled) {
      return;
    }
    const retirement = slot.retiring;
    if (!retirement) {
      finish(new Error("Worker resource cleanup closed without a receipt"));
      return;
    }
    awaitingRetirement = true;
    selectedRetirement = retirement;
    void retirement.result.then(
      () => finish(),
      (error: unknown) => finish(toErrorObject(error, "Worker resource cleanup retirement failed")),
    );
  });
  try {
    worker.postMessage({ closeResource: true, key, resourcePort: port2 }, [port2]);
  } catch (error) {
    finish(toErrorObject(error, "Worker resource cleanup could not be sent"));
  }
  return completion.operation;
}
