export type DiscordEventQueueOptions = {
  maxQueueSize?: number;
  maxConcurrency?: number;
  slowListenerThreshold?: number;
};

type DiscordEventQueueJob = {
  eventType: string;
  listenerName: string;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_MAX_CONCURRENCY = 50;
const DEFAULT_SLOW_LISTENER_THRESHOLD_MS = 30_000;

export class DiscordEventQueue {
  private readonly options: Required<DiscordEventQueueOptions>;
  private readonly queue: DiscordEventQueueJob[] = [];
  private queueHead = 0;
  private processing = 0;

  constructor(options: DiscordEventQueueOptions = {}) {
    this.options = {
      maxQueueSize: options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      maxConcurrency: options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      slowListenerThreshold: options.slowListenerThreshold ?? DEFAULT_SLOW_LISTENER_THRESHOLD_MS,
    };
  }

  enqueue(params: Omit<DiscordEventQueueJob, "resolve" | "reject">): Promise<void> {
    if (this.pendingQueueSize >= this.options.maxQueueSize) {
      return Promise.reject(
        new Error(
          `Discord event queue is full for ${params.eventType}; maxQueueSize=${this.options.maxQueueSize}`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ ...params, resolve, reject });
      this.processNext();
    });
  }

  private get pendingQueueSize(): number {
    return Math.max(0, this.queue.length - this.queueHead);
  }

  private takeNextJob(): DiscordEventQueueJob | undefined {
    const job = this.queue[this.queueHead];
    this.queueHead += 1;
    if (this.queueHead >= this.queue.length) {
      this.queue.length = 0;
      this.queueHead = 0;
    } else if (this.queueHead > 256 && this.queueHead * 2 > this.queue.length) {
      this.queue.splice(0, this.queueHead);
      this.queueHead = 0;
    }
    return job;
  }

  private processNext(): void {
    while (this.processing < this.options.maxConcurrency && this.pendingQueueSize > 0) {
      const job = this.takeNextJob();
      if (!job) {
        return;
      }
      this.processing += 1;
      void this.runJob(job)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.processing -= 1;
          this.processNext();
        });
    }
  }

  private async runJob(job: DiscordEventQueueJob): Promise<void> {
    const startedAt = Date.now();
    try {
      await Promise.resolve().then(() => job.run());
      this.logSlowListener(job, Date.now() - startedAt);
    } catch (error) {
      console.error(
        `[EventQueue] Listener ${job.listenerName} failed for event ${job.eventType}:`,
        error,
      );
    }
  }

  private logSlowListener(job: DiscordEventQueueJob, durationMs: number): void {
    if (durationMs < this.options.slowListenerThreshold) {
      return;
    }
    console.warn(
      `[EventQueue] Slow listener detected: ${job.listenerName} took ${durationMs}ms for event ${job.eventType}`,
    );
  }
}
