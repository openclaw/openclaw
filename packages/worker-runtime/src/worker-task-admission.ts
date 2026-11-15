import {
  DEFAULT_WORKER_PENDING_BYTES,
  type WorkerComputeCapacity,
} from "./worker-task-capacity.js";
import { WorkerTaskError } from "./worker-task-error.js";

type ClassedTask = {
  inputBytes: number;
  admitted: boolean;
  options: { pointRead?: true; onRequest?: unknown; onRequestSync?: unknown };
};

/** Class 0 (point reads) keeps its own arrival order ahead of every queued bulk task. */
export function enqueueWorkerTask<T extends Pick<ClassedTask, "options">>(queue: T[], task: T) {
  const firstBulk = task.options.pointRead
    ? queue.findIndex((queued) => !queued.options.pointRead)
    : -1;
  queue.splice(firstBulk === -1 ? queue.length : firstBulk, 0, task);
}

/** Owns a pool's admitted inputs and notifies rejected callers when their budget can fit. */
export class WorkerTaskAdmission {
  private taskCount = 0;
  private byteCount = 0;
  private closed = false;
  private readonly waiters = new Map<number, { promise: Promise<void>; resolve: () => void }>();
  private stopWatchingCapacity?: () => void;

  constructor(
    private readonly maxPendingTasks: number,
    private readonly maxPendingBytes: number,
    private readonly shared?: WorkerComputeCapacity,
  ) {
    for (const [name, value] of Object.entries({ maxPendingTasks, maxPendingBytes })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
  }

  get pendingTasks(): number {
    return this.taskCount;
  }

  get pendingBytes(): number {
    return this.byteCount;
  }

  /** Class 0 skips bulk admission but cannot request callbacks into the host. */
  admitTask(task: ClassedTask): Error | undefined {
    const { pointRead, onRequest, onRequestSync } = task.options;
    if (pointRead) {
      return onRequest || onRequestSync
        ? new TypeError("Point reads carry their facts and cannot call back into the host")
        : undefined;
    }
    task.admitted = this.admit(task.inputBytes);
    return task.admitted
      ? undefined
      : new WorkerTaskError("worker task capacity reached", "overloaded", {
          capacityAvailable: this.waitForCapacity(task.inputBytes),
        });
  }

  admit(inputBytes: number): boolean {
    if (
      this.taskCount >= this.maxPendingTasks ||
      this.byteCount + inputBytes > this.maxPendingBytes ||
      (this.shared && !this.shared.admit(inputBytes))
    ) {
      return false;
    }
    this.taskCount++;
    this.byteCount += inputBytes;
    return true;
  }

  finish(inputBytes: number): void {
    this.taskCount--;
    this.byteCount -= inputBytes;
    this.shared?.finish(inputBytes);
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  waitForCapacity(inputBytes: number): Promise<void> | undefined {
    if (
      inputBytes > this.maxPendingBytes ||
      (this.shared && inputBytes > DEFAULT_WORKER_PENDING_BYTES)
    ) {
      return undefined;
    }
    const existing = this.waiters.get(inputBytes);
    if (existing) {
      return existing.promise;
    }
    const available = Promise.withResolvers<void>();
    this.waiters.set(inputBytes, available);
    this.stopWatchingCapacity ??= this.shared?.subscribeAdmission(this.notify);
    this.notify();
    return available.promise;
  }

  private readonly notify = (): void => {
    for (const [inputBytes, waiter] of this.waiters) {
      if (
        this.closed ||
        (this.taskCount < this.maxPendingTasks &&
          this.byteCount + inputBytes <= this.maxPendingBytes &&
          (!this.shared || this.shared.canAdmit(inputBytes)))
      ) {
        this.waiters.delete(inputBytes);
        waiter.resolve();
      }
    }
    if (!this.waiters.size) {
      this.stopWatchingCapacity?.();
      this.stopWatchingCapacity = undefined;
    }
  };
}
