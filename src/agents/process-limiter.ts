/**
 * Process spawning limiter to prevent fork bombs and resource exhaustion.
 * Implements exponential backoff and process pool limits.
 */

export interface ProcessLimiterConfig {
  maxConcurrentProcesses?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  backoffMultiplier?: number;
  healthCheckIntervalMs?: number;
}

export interface ProcessHealth {
  totalSpawned: number;
  activeProcesses: number;
  failedSpawns: number;
  lastFailureTime?: number;
  lastError?: string;
  averageBackoffMs: number;
}

export class ProcessLimiter {
  private maxConcurrentProcesses: number;
  private initialBackoffMs: number;
  private maxBackoffMs: number;
  private backoffMultiplier: number;
  private activeProcessCount = 0;
  private queuedSpawns: Array<() => Promise<void>> = [];
  private failureCount = 0;
  private lastFailureTime = 0;
  private totalBackoffMs = 0;
  private backoffCount = 0;
  private totalSpawned = 0;
  private lastError: string | undefined;

  constructor(config: ProcessLimiterConfig = {}) {
    this.maxConcurrentProcesses = config.maxConcurrentProcesses ?? 10;
    this.initialBackoffMs = config.initialBackoffMs ?? 50;
    this.maxBackoffMs = config.maxBackoffMs ?? 30000;
    this.backoffMultiplier = config.backoffMultiplier ?? 1.5;
  }

  /**
   * Execute a process spawn with resource limits and backoff.
   */
  async executeWithLimits<T>(
    executor: () => Promise<T>,
    currentFailureCount: number = 0,
  ): Promise<T> {
    // Check if we've hit the concurrent process limit
    if (this.activeProcessCount >= this.maxConcurrentProcesses) {
      return new Promise((resolve, reject) => {
        this.queuedSpawns.push(async () => {
          try {
            resolve(await this.executeWithLimits(executor, currentFailureCount));
          } catch (error) {
            reject(error);
          }
        });
      });
    }

    // Apply exponential backoff on failures
    if (currentFailureCount > 0) {
      const backoffMs = this.calculateBackoff(currentFailureCount);
      this.totalBackoffMs += backoffMs;
      this.backoffCount++;
      await this.sleep(backoffMs);
    }

    this.activeProcessCount++;
    this.totalSpawned++;

    try {
      const result = await executor();
      this.failureCount = 0; // Reset failure counter on success
      this.lastFailureTime = 0;
      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();
      this.lastError = error instanceof Error ? error.message : String(error);

      // Re-throw to allow caller to handle, but limit cascade
      if (this.failureCount > 5) {
        throw new Error(
          `Process spawn cascade detected (${this.failureCount} failures). Throttling subsequent spawns.`,
        );
      }

      throw error;
    } finally {
      this.activeProcessCount--;
      this.processQueue();
    }
  }

  /**
   * Calculate exponential backoff delay.
   * Formula: min(initial * multiplier^failures, max)
   */
  private calculateBackoff(failureCount: number): number {
    const backoffMs = Math.min(
      this.initialBackoffMs * Math.pow(this.backoffMultiplier, failureCount),
      this.maxBackoffMs,
    );
    return Math.floor(backoffMs);
  }

  /**
   * Process queued spawns when capacity becomes available.
   */
  private processQueue(): void {
    if (this.activeProcessCount >= this.maxConcurrentProcesses || this.queuedSpawns.length === 0) {
      return;
    }

    const spawn = this.queuedSpawns.shift();
    if (spawn) {
      spawn().catch((error) => {
        console.error("Queued spawn failed:", error);
      });
    }
  }

  /**
   * Get current process health metrics.
   */
  getHealth(): ProcessHealth {
    return {
      totalSpawned: this.totalSpawned,
      activeProcesses: this.activeProcessCount,
      failedSpawns: this.failureCount,
      lastFailureTime: this.lastFailureTime || undefined,
      lastError: this.lastError,
      averageBackoffMs: this.backoffCount > 0 ? this.totalBackoffMs / this.backoffCount : 0,
    };
  }

  /**
   * Reset limiter state (use with caution).
   */
  reset(): void {
    this.activeProcessCount = 0;
    this.queuedSpawns = [];
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.totalBackoffMs = 0;
    this.backoffCount = 0;
    this.lastError = undefined;
  }

  /**
   * Helper to sleep for given duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Global instance
export const processLimiter = new ProcessLimiter();
