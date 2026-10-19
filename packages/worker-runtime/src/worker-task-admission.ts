import {
  DEFAULT_WORKER_PENDING_BYTES,
  type WorkerComputeCapacity,
} from "./worker-task-capacity.js";

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
