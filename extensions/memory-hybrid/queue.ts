export interface QueueOptions {
  delayMs?: number;
}

/**
 * Orchestrated Background Queue
 *
 * Ensures that heavy memory tasks (LLM calls, embeddings, graph extraction)
 * are processed strictly sequentially with a delay between them.
 * This prevents Gemini API 429 (Rate Limit) errors while allowing the
 * agent to respond immediately to the user.
 */
export class MemoryQueue {
  private queue: Array<{ name: string; task: () => Promise<void> }> = [];
  private processing = false;
  private delayMs: number;

  constructor(options: QueueOptions = {}) {
    this.delayMs = options.delayMs ?? 1000;
  }

  /**
   * Push a task to the queue. Returns immediately.
   */
  push(name: string, task: () => Promise<void>): void {
    this.queue.push({ name, task });
    if (!this.processing) {
      // Start processing in the background (no await)
      this.processNext().catch(() => {
        // Top-level catch for the background process
        this.processing = false;
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

    const { task } = entry;

    try {
      await task();
    } catch (err) {
      // Silence is golden in background tasks, but we could log to tracer here
    }

    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    // Continue to next task
    return this.processNext();
  }

  /**
   * Returns current queue size (number of pending tasks)
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Returns true if a task is currently being processed
   */
  get isWorking(): boolean {
    return this.processing;
  }
}
