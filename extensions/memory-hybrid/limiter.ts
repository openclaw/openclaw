export enum TaskPriority {
  HIGH = 0, // Recall (blocking user)
  NORMAL = 1, // Smart Capture
  LOW = 2, // Dream Mode / Consolidation
}

export interface LimiterOptions {
  minDelayMs?: number;
  maxRequestsPerMinute?: number;
}

interface QueuedTask<T = unknown> {
  id: string;
  priority: TaskPriority;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  queuedAt: number;
}

export class ApiRateLimiter {
  private queue: QueuedTask[] = [];
  private lastRequestTime = 0;
  private processing = false;
  private minDelayMs: number;
  private maxRequestsPerMinute: number;

  // Track tokens for RPM (simpler than full bucket for 15 RPM)
  private tokens: number[] = [];

  constructor(options: LimiterOptions = {}) {
    this.minDelayMs = options.minDelayMs ?? 2000; // 2s default for Gemini burst
    this.maxRequestsPerMinute = options.maxRequestsPerMinute ?? 15; // Gemini free tier limit
  }

  /**
   * Execute a task (API call) through the limiter.
   * Tasks with higher priority jump to the front of the queue.
   */
  public async execute<T>(
    fn: () => Promise<T>,
    priority: TaskPriority = TaskPriority.NORMAL,
    name = "anonymous",
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<unknown> = {
        id: Math.random().toString(36).slice(2),
        priority,
        fn,
        resolve: resolve as (value: unknown) => void,
        reject,
        queuedAt: Date.now(),
      };

      this.queue.push(task);
      this.sortQueue();

      if (!this.processing) {
        this.processNext();
      }
    });
  }

  private sortQueue(): void {
    // Sort by priority first (lower number = higher priority),
    // then by FIFO (earlier queuedAt first)
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.queuedAt - b.queuedAt;
    });
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;

    // Check constraints
    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;

    // 1. Burst protection (minDelayMs)
    if (timeSinceLast < this.minDelayMs) {
      const wait = this.minDelayMs - timeSinceLast;
      await new Promise((r) => setTimeout(r, wait));
      return this.processNext(); // Check again after waiting
    }

    // 2. RPM protection
    this.cleanupTokens(now);
    if (this.tokens.length >= this.maxRequestsPerMinute) {
      // Wait until the oldest token expires (60s after its creation)
      const oldestToken = this.tokens[0];
      const wait = Math.max(0, 60000 - (now - oldestToken));
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
        return this.processNext();
      }
    }

    const task = this.queue.shift();
    if (!task) {
      this.processing = false;
      return;
    }

    // Execute!
    this.lastRequestTime = Date.now();
    this.tokens.push(this.lastRequestTime);

    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    }

    // Move to next one (with slight delay to avoid tight loop race)
    setImmediate(() => this.processNext());
  }

  private cleanupTokens(now: number): void {
    const minuteAgo = now - 60000;
    while (this.tokens.length > 0 && this.tokens[0] < minuteAgo) {
      this.tokens.shift();
    }
  }

  public get pendingCount(): number {
    return this.queue.length;
  }
}
