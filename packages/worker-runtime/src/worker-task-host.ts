import type { Transferable, WorkerOptions } from "node:worker_threads";
import type { RetainedOperation } from "./retained-operation.js";
import type { WorkerLifecycle, RetainedNativeWorker } from "./worker-lifecycle.js";
import type { WorkerComputeCapacity } from "./worker-task-capacity.js";

export type WorkerRetirementReason =
  | "idle_timeout"
  | "memory_pressure"
  | "closed"
  | "rotation"
  | "cancelled"
  | "failure"
  | "exit";

export type ResourceOwningPool = {
  startCloseResources(key?: string): RetainedOperation<void>;
};

export type WorkerTaskObservation = { started(): void; completed(): void };

/** Host facts and resource owners are supplied once, before a pool admits work. */
export type WorkerTaskHost = {
  /** Prepared host policy takes precedence over legacy caller sizing. */
  maxWorkers?: number;
  /** Internal served workers acknowledge initialization; arbitrary SDK Workers do not. */
  requiresReady?: true;
  createWorker(
    url: URL,
    options: Omit<WorkerOptions, "eval">,
  ): { worker: WorkerLifecycle; native?: RetainedNativeWorker };
  /** Coalesce only service owners known to be shared within this captured pass. */
  serviceNativeWorkers(workers: readonly RetainedNativeWorker[]): void;
  prepareResources(): Promise<unknown>;
  releaseTemporaryDirectory(directory: string): Promise<void>;
  captureTaskContext(worker: WorkerLifecycle): unknown;
  taskContextTransferList?(context: unknown): readonly Transferable[];
  createTaskObserver?(url: URL): (operation?: string) => WorkerTaskObservation;
  receiveMessage(worker: WorkerLifecycle, message: unknown): boolean;
  workerStarted(worker: WorkerLifecycle, pool: object): void;
  workerRetiring(worker: WorkerLifecycle, reason: WorkerRetirementReason): void;
  computeCapacity: WorkerComputeCapacity;
  pools: {
    register<T extends ResourceOwningPool>(pool: T): T;
    close(
      pool: ResourceOwningPool,
      closures: readonly Promise<void>[],
      finish: () => Promise<void>,
    ): Promise<void>;
  };
};

/** Capture before callbacks so nested servicing advances a fresh set of owners. */
export function serviceNativeWorkerPass(
  host: Pick<WorkerTaskHost, "serviceNativeWorkers">,
  slots: Iterable<{ native?: RetainedNativeWorker }>,
): void {
  const workers: RetainedNativeWorker[] = [];
  for (const slot of slots) {
    if (slot.native) {
      workers.push(slot.native);
    }
  }
  host.serviceNativeWorkers(workers);
}
