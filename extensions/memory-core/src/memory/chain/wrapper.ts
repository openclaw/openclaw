/**
 * Chain Memory Backend - Provider Wrapper
 *
 * Wrap single provider with timeout and circuit breaker
 *
 * @module wrapper
 * @author Tutu
 * @date 2026-03-09
 */

import type {
  MemorySearchManager,
  MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { CircuitBreaker } from "./circuit-breaker.js";
import type {
  ProviderConfig,
  ProviderStats,
  ProviderWrapper as IProviderWrapper,
  CircuitBreakerState,
} from "./types.js";

/**
 * Provider Wrapper Implementation
 */
export class ProviderWrapper implements IProviderWrapper {
  config: ProviderConfig;
  manager: MemorySearchManager;
  stats: ProviderStats;
  circuitBreaker: {
    state: CircuitBreakerState;
    failures: number;
    lastFailureTime: number;
  };

  private circuitBreakerInstance: CircuitBreaker;

  constructor(config: ProviderConfig, manager: MemorySearchManager) {
    this.config = config;
    this.manager = manager;

    // Initialize Circuit Breaker
    this.circuitBreakerInstance = new CircuitBreaker({
      failureThreshold: config.circuitBreaker?.failureThreshold ?? 5,
      resetTimeoutMs: config.circuitBreaker?.resetTimeoutMs ?? 60000,
    });

    // Initialize statistics
    this.stats = {
      name: config.name,
      priority: config.priority,
      health: "healthy",
      circuitBreakerState: "CLOSED",
      failureCount: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      avgResponseTime: 0,
    };

    // Initialize Circuit Breaker state
    this.circuitBreaker = {
      state: "CLOSED",
      failures: 0,
      lastFailureTime: 0,
    };
  }

  /**
   * Execute search
   */
  async search(
    query: string,
    options?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const timeout = this.config.timeout?.search ?? 5000;

    return this.executeWithTimeout(() => this.manager.search(query, options), timeout, "search");
  }

  /**
   * Read file through wrapper (with timeout and circuit breaker)
   */
  async readFile(options: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ path: string; text: string }> {
    const timeout = this.config.timeout?.search ?? 5000;

    return this.executeWithTimeout(() => this.manager.readFile(options), timeout, "readFile");
  }

  /**
   * Probe embedding availability
   */
  async probeEmbeddingAvailability(): Promise<{ ok: boolean; error?: string }> {
    return this.manager.probeEmbeddingAvailability();
  }

  /**
   * Probe vector availability
   */
  async probeVectorAvailability(): Promise<boolean> {
    return this.manager.probeVectorAvailability();
  }

  /**
   * Close provider
   */
  async close(): Promise<void> {
    if (this.manager.close) {
      await this.manager.close();
    }
  }

  /**
   * Check if available
   */
  isAvailable(): boolean {
    // Check if enabled
    if (this.config.enabled === false) {
      return false;
    }

    // Check Circuit Breaker
    return !this.circuitBreakerInstance.isOpen();
  }

  /**
   * Record Success
   */
  recordSuccess(): void {
    this.circuitBreakerInstance.recordSuccess();
    this.updateCircuitBreakerState();

    this.stats.successfulRequests++;
    this.stats.totalRequests++;
  }

  /**
   * Record Failure
   */
  recordFailure(): void {
    this.circuitBreakerInstance.recordFailure();
    this.updateCircuitBreakerState();

    this.stats.failedRequests++;
    this.stats.totalRequests++;
    this.stats.failureCount = this.circuitBreakerInstance.getFailureCount();
    this.stats.lastFailureTime = Date.now();
  }

  /**
   * Execute with timeout and circuit breaker
   */
  private async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    operationName: string,
  ): Promise<T> {
    // Check Circuit Breaker
    if (this.circuitBreakerInstance.isOpen()) {
      throw new Error(`Circuit breaker is OPEN for ${this.config.name}`);
    }

    const startTime = Date.now();
    const maxAttempts = this.config.retry?.maxAttempts ?? 3;
    const backoffMs = this.config.retry?.backoffMs ?? 1000;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let timeoutId: NodeJS.Timeout | undefined;

      try {
        // Create timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`${operationName} timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        });

        // Execute operation
        const result = await Promise.race([operation(), timeoutPromise]);

        // Clear timeout on success to avoid memory leak
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        // Success
        const responseTime = Date.now() - startTime;
        this.updateResponseTime(responseTime);
        this.recordSuccess();

        return result;
      } catch (error) {
        // Clear timeout on failure as well
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        lastError = error instanceof Error ? error : new Error(String(error));

        // If not last attempt, wait before retry
        if (attempt < maxAttempts) {
          await this.sleep(backoffMs * attempt);
        }
      }
    }

    // All attempts failed
    this.recordFailure();
    throw lastError || new Error(`${operationName} failed after ${maxAttempts} attempts`);
  }

  /**
   * Update statistics
   */
  private updateCircuitBreakerState(): void {
    const state = this.circuitBreakerInstance.getState();
    this.stats.circuitBreakerState = state;
    this.circuitBreaker.state = state;
    this.circuitBreaker.failures = this.circuitBreakerInstance.getFailureCount();

    if (state === "OPEN") {
      this.circuitBreaker.lastFailureTime = Date.now();
    }
  }

  /**
   * Update average response time
   */
  private updateResponseTime(responseTime: number): void {
    // Use exponential moving average
    const alpha = 0.1;
    this.stats.avgResponseTime =
      this.stats.avgResponseTime === 0
        ? responseTime
        : alpha * responseTime + (1 - alpha) * this.stats.avgResponseTime;
  }

  /**
   * Sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get statistics
   */
  getStats(): ProviderStats {
    return { ...this.stats };
  }

  /**
   * Reset Circuit Breaker
   */
  resetCircuitBreaker(): void {
    this.circuitBreakerInstance.reset();
    this.updateCircuitBreakerState();
    this.stats.failureCount = 0;
  }
}
