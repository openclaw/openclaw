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
  private wakeupResolver: (() => void) | null = null;
  private tokens: number[] = [];

  constructor(options: LimiterOptions = {}) {
    this.minDelayMs = options.minDelayMs ?? 2000;
    this.maxRequestsPerMinute = options.maxRequestsPerMinute ?? 15;
  }

  /**
   * Interruptible sleep. Wakes up immediately if wakeupResolver is called.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timeout: any;
      const wake = () => {
        clearTimeout(timeout);
        this.wakeupResolver = null;
        resolve();
      };
      this.wakeupResolver = wake;
      timeout = setTimeout(wake, ms);
    });
  }

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

      // If we are sleeping (waiting for LOW tasks), wake up to re-evaluate for HIGH tasks
      if (this.wakeupResolver) {
        this.wakeupResolver();
      }

      if (!this.processing) {
        this.processNext();
      }
    });
  }

  private sortQueue(): void {
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

    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;

    // Peek first without shifting (we might need to wait for quota)
    const task = this.queue[0];

    // 1. Burst protection (minDelayMs)
    if (timeSinceLast < this.minDelayMs) {
      const wait = this.minDelayMs - timeSinceLast;
      await this.sleep(wait);
      return this.processNext();
    }

    // 2. RPM protection with FAST-LANE logic
    this.cleanupTokens(now);

    // Background tasks (LOW) can only use 70% of the token bucket.
    // High/Normal tasks get the full bucket.
    const isBackground = task.priority > TaskPriority.NORMAL;
    const effectiveMax = isBackground
      ? Math.max(1, Math.floor(this.maxRequestsPerMinute * 0.7))
      : this.maxRequestsPerMinute;

    if (this.tokens.length >= effectiveMax) {
      // Find the token that blocks this request from running
      const tokenIndexToWait = this.tokens.length - effectiveMax;
      const blockingToken = this.tokens[tokenIndexToWait];
      const wait = Math.max(0, 60000 - (now - blockingToken));

      if (wait > 0) {
        await this.sleep(wait + 10); // Sleep until it expires
        return this.processNext();
      }
    }

    // Constraints met, execute top task
    const activeTask = this.queue.shift();
    if (!activeTask) {
      this.processing = false;
      return;
    }

    this.lastRequestTime = Date.now();
    this.tokens.push(this.lastRequestTime);

    try {
      const result = await activeTask.fn();
      activeTask.resolve(result);
    } catch (err) {
      activeTask.reject(err);
    }

    // Release sync event loop briefly before continuing
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
