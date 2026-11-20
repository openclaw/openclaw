import type { Transferable, WorkerOptions } from "node:worker_threads";
import type { RetainedOperation } from "./retained-operation.js";
import type { WorkerLifecycle, RetainedNativeWorker } from "./worker-lifecycle.js";
import type { WorkerComputeCapacity } from "./worker-task-capacity.js";
import type {
  WorkerTaskPoolOptions,
  WorkerTaskPoolOwnerOptions,
} from "./worker-task-pool.types.js";

export type WorkerRetirementReason =
  | "idle_timeout"
  | "memory_pressure"
  | "closed"
  | "eviction"
  | "idle-expiry"
  | "dispose"
  | "shutdown"
  | "crash"
  | "gc-thrash"
  | "gc-storm"
  | "rotation"
  | "cancelled"
  | "failure"
  | "exit";

export type ResourceOwningPool = {
  startCloseResources(key?: string): RetainedOperation<void>;
};

export type WorkerTaskObservation = { started(): void; completed(): void };

/** Host memory policy for one pool; the pool keeps its queue and refused work waits there.
 * The host releases the pool's reservations when it closes or is collected. */
export type WorkerPoolMemoryBudget = {
  /** Ordinary workers always admitted, including settlement capacity. */
  readonly floor: number;
  /** False once the host replaced this policy; the pool then binds the current one. */
  isCurrent(): boolean;
  /** Admit one ordinary worker beyond the floor. */
  admitGrowth(): boolean;
  releaseGrowth(count: number): void;
  /** The point-read lane is mandatory; reserve it once it is first used. */
  reservePointReadFloor(): void;
  waitStarted(): void;
  waitFinished(elapsedMs: number): void;
};

/** Host facts and resource owners are supplied once, before a pool admits work. */
export type WorkerTaskHost = {
  /** Prepared host policy takes precedence over legacy caller sizing. */
  maxWorkers?: number;
  /** Optional memory admission; undefined keeps the pool's existing sizing. */
  createMemoryBudget?(
    pool: object,
    url: URL,
    maxWorkers: number,
  ): WorkerPoolMemoryBudget | undefined;
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
  /** Return only bounded, privacy-safe labels; never retain or serialize task input. */
  describeTask?(url: URL, input: unknown, operation?: string): string;
  receiveMessage(worker: WorkerLifecycle, message: unknown): boolean;
  observeResourceReply?(this: void): void;
  /** Capture diagnostics before construction detaches from the task's async context. */
  captureWorkerStartObserver?(url: URL): (() => void) | undefined;
  workerStarted(
    worker: WorkerLifecycle,
    pool: object,
    maxWorkers: number,
    options: Pick<WorkerTaskPoolOptions<unknown>, "idleTimeoutMs" | "burstIdleTimeoutMs">,
    owner: Pick<WorkerTaskPoolOwnerOptions, "retainOneIdleWorker">,
  ): void;
  workerRetiring(worker: WorkerLifecycle, reason: WorkerRetirementReason): void;
  /** Join host effects accepted by this worker before releasing its execution capacity. */
  workerStopped?(worker: WorkerLifecycle): void | Promise<void>;
  /** Best-effort telemetry before native stop; the host bounds waiting, including synchronous service. */
  flushWorkerDiagnostics?(
    worker: WorkerLifecycle,
    reason: WorkerRetirementReason,
  ): RetainedOperation<void> | undefined;
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
