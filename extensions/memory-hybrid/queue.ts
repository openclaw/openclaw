import type { Logger } from "./src/infra/tracer.js";

export interface QueueOptions {
  delayMs?: number;
  maxSize?: number;
  onError?: (name: string, error: unknown) => void;
  logger?: Logger;
}

export class MemoryQueue {
  private queue: Array<{ name: string; task: () => Promise<void> }> = [];
  private processing = false;
  private stopping = false;
  private delayMs: number;
  private maxSize: number;
  private logger?: Logger;
  private onError: (name: string, error: unknown) => void;

  constructor(options: QueueOptions = {}) {
    this.delayMs = options.delayMs ?? 1000;
    this.maxSize = options.maxSize ?? 100;
    this.logger = options.logger;
    this.onError = options.onError ?? (() => {});
  }

  push(name: string, task: () => Promise<void>): void {
    if (this.stopping) {
      this.logger?.warn(`[memory-hybrid] Rejecting task "${name}" because queue is stopping.`);
      return;
    }

    if (this.queue.length >= this.maxSize) {
      this.onError(
        name,
        new Error(`Queue overflow: ${this.queue.length} pending tasks (max: ${this.maxSize})`),
      );
      this.logger?.warn(`[memory-hybrid] Queue overflow in ${name}`);
      return;
    }
    this.queue.push({ name, task });
    if (!this.processing) {
      this.processNext().catch((err) => {
        this.onError("queue-loop", err);
        this.processing = false;
        // Restart loop if items remain (prevent queue stall)
        if (this.queue.length > 0) {
          this.processNext().catch(() => {});
        }
      });
    }
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;
    const entry = this.queue.shift();
    if (!entry) {
      this.processing = false;
      return;
    }

    const { name, task } = entry;

    try {
      await task();
    } catch (err) {
      // Report error instead of swallowing it silently
      this.onError(name, err);
    }

    if (this.delayMs > 0 && !this.stopping) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    return this.processNext();
  }

  /**
   * Gracefully shuts down the queue by draining all pending tasks.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.queue.length === 0 && !this.processing) {
      return;
    }
    // Wait for the current processing loop to finish (which finishes when queue is empty)
    while (this.processing || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Returns current queue size (number of pending tasks) */
  get size(): number {
    return this.queue.length;
  }

  /** Returns true if a task is currently being processed */
  get isWorking(): boolean {
    return this.processing;
  }
}
