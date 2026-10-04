import type { Transferable } from "node:worker_threads";
import type { WorkerLifecycle } from "./worker-lifecycle.js";
import type { WorkerTaskHost } from "./worker-task-host.js";
import { releaseWorkerNativeSectionsOnExit } from "./worker-task-native-sections.js";
import type { Slot, Task, WorkerTaskPoolOptions } from "./worker-task-pool.types.js";

export function postWorkerTaskInput<Input, Output>(
  worker: WorkerLifecycle,
  slot: Slot<Input, Output>,
  task: Task<Input, Output>,
  input: Input,
  transferList: readonly Transferable[] | undefined,
  taskContext: unknown,
): void {
  const transferStartedAt = performance.now();
  worker.postMessage(
    {
      input,
      taskId: task.id,
      interactive: Boolean(task.options.onRequest || task.options.onRequestSync),
      nativeSections: slot.nativeSections.buffer,
      taskContext,
      sampleMemory: true,
    },
    transferList,
  );
  task.transferMs += performance.now() - transferStartedAt;
}

/** Physical construction and listeners share the pool's detached creation scope. */
export function createWorkerTaskPoolWorker<Input, Output>(params: {
  slot: Slot<Input, Output>;
  options: Pick<WorkerTaskPoolOptions<Output>, "workerUrl" | "workerOptions" | "prepareWorker">;
  host: WorkerTaskHost;
  runInContext: <T>(operation: () => T) => T;
  unavailableError: (message: string) => Error;
  onStarted: (worker: WorkerLifecycle) => void;
  onMessage: (message: unknown) => void;
  onFailure: (error: Error) => void;
  onExit: (code: number | undefined, counted: boolean) => void;
}): WorkerLifecycle {
  const { slot, options } = params;
  const worker: WorkerLifecycle = params.runInContext(() => {
    const prepared = options.prepareWorker?.();
    slot.releaseResources = prepared?.releaseResources;
    const temporaryDirectory = prepared?.temporaryDirectory;
    if (temporaryDirectory) {
      const cleanup = params.host.prepareResources();
      const releaseResources = slot.releaseResources;
      slot.releaseResources = async () => {
        try {
          await cleanup;
          await params.host.releaseTemporaryDirectory(temporaryDirectory);
        } finally {
          await releaseResources?.();
        }
      };
    }
    const workerUrl = options.workerUrl;
    const workerOptions = {
      ...options.workerOptions,
      ...prepared?.options,
    };
    // Preparation and option getters can synchronously close the task.
    if (slot.retiring) {
      throw params.unavailableError("worker creation closed during preparation");
    }
    const created = params.host.createWorker(workerUrl, workerOptions);
    slot.native = created.native;
    return created.worker;
  });
  let counted = false;
  const started = () => {
    if (counted) {
      return;
    }
    counted = true;
    params.onStarted(worker);
  };
  if (slot.native) {
    slot.native.on("started", started);
    slot.native.on("execution-exit", (code) => {
      releaseWorkerNativeSectionsOnExit(slot.nativeSections);
      if (!slot.retiring) {
        params.onFailure(params.unavailableError(`worker exited with code ${code}`));
      }
    });
  } else {
    started();
  }
  slot.worker = worker;
  worker.on("message", (message: unknown) => {
    // Native message events inherit the Worker's detached creation context.
    if (params.host.receiveMessage(worker, message)) {
      return;
    }
    const task = slot.task;
    if (task) {
      task.runInContext(() => params.onMessage(message));
    } else {
      params.onMessage(message);
    }
  });
  worker.on("error", (error) => params.onFailure(params.unavailableError(String(error))));
  worker.on("messageerror", (error) => params.onFailure(params.unavailableError(String(error))));
  worker.once("exit", (code) => {
    releaseWorkerNativeSectionsOnExit(slot.nativeSections);
    const wasCounted = counted;
    counted = false;
    params.onExit(code, wasCounted);
  });
  return worker;
}
