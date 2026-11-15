import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
  type WorkerComputeCapacity,
} from "./worker-task-capacity.js";
import { WorkerTaskError } from "./worker-task-error.js";

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

  /** Formats diagnostics only on refusal; successful admission returns undefined. */
  admit(inputBytes: number, describeTask: () => string | undefined): WorkerTaskError | undefined {
    let detail: string;
    if (this.taskCount >= this.maxPendingTasks) {
      detail = `pool pending tasks: pendingTasks=${this.taskCount} maxPendingTasks=${this.maxPendingTasks} inputBytes=${inputBytes}`;
    } else if (this.byteCount + inputBytes > this.maxPendingBytes) {
      detail = `pool pending bytes: pendingBytes=${this.byteCount} maxPendingBytes=${this.maxPendingBytes} inputBytes=${inputBytes}`;
    } else if (this.shared && !this.shared.admit(inputBytes)) {
      const { pendingTasks, pendingBytes } = this.shared.getSnapshot();
      detail =
        pendingTasks >= DEFAULT_WORKER_PENDING_TASKS
          ? `shared compute pending tasks: pendingTasks=${pendingTasks} maxPendingTasks=${DEFAULT_WORKER_PENDING_TASKS} inputBytes=${inputBytes}`
          : `shared compute pending bytes: pendingBytes=${pendingBytes} maxPendingBytes=${DEFAULT_WORKER_PENDING_BYTES} inputBytes=${inputBytes}`;
    } else {
      this.taskCount++;
      this.byteCount += inputBytes;
      return undefined;
    }
    const label = describeTask();
    return new WorkerTaskError(
      `worker task capacity reached [${label ? `task=${label} ` : ""}${detail}]`,
      "overloaded",
      { capacityAvailable: this.waitForCapacity(inputBytes) },
    );
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
