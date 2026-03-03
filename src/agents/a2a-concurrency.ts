import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("a2a-concurrency");

/** Per-agent A2A concurrency configuration. */
export interface A2AConcurrencyConfig {
  /** Maximum concurrent A2A flows per agent. Default: 3 */
  maxConcurrentFlows: number;
  /** Maximum wait time for a permit (ms). Default: 30000 */
  queueTimeoutMs: number;
}

/** Default configuration values. */
export const DEFAULT_A2A_CONCURRENCY_CONFIG: A2AConcurrencyConfig = {
  maxConcurrentFlows: 3,
  queueTimeoutMs: 30_000,
};

/** Error thrown when concurrency limit is exceeded and queue times out. */
export class A2AConcurrencyError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly flowId: string,
    public readonly activeCount: number,
    public readonly queueTimeoutMs: number,
  ) {
    super(
      `A2A concurrency limit exceeded for agent ${agentId}: ` +
        `${activeCount} active flows, timed out after ${queueTimeoutMs}ms`,
    );
    this.name = "A2AConcurrencyError";
  }
}

/** Per-agent A2A concurrency gate interface. */
export interface A2AConcurrencyGate {
  acquire(agentId: string, flowId: string): Promise<void>;
  release(agentId: string, flowId: string): void;
  activeCount(agentId: string): number;
  queuedCount(agentId: string): number;
}

interface WaitEntry {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Per-agent semaphore for A2A flow concurrency control.
 * Each agent ID maintains an independent counter and FIFO wait queue.
 */
export class A2AConcurrencyGateImpl implements A2AConcurrencyGate {
  private readonly active = new Map<string, number>();
  private readonly waitQueues = new Map<string, WaitEntry[]>();

  constructor(private readonly config: A2AConcurrencyConfig) {}

  async acquire(agentId: string, flowId: string): Promise<void> {
    const current = this.active.get(agentId) ?? 0;

    if (current < this.config.maxConcurrentFlows) {
      this.active.set(agentId, current + 1);
      return;
    }

    // Limit exceeded — queue and wait
    log.info(
      `a2a-concurrency: throttling flow ${flowId} for agent ${agentId} ` +
        `(active: ${current}, queued: ${this.queuedCount(agentId)})`,
    );

    await new Promise<void>((resolve, reject) => {
      let entry: WaitEntry;
      const timer = setTimeout(() => {
        // Remove from queue on timeout
        const queue = this.waitQueues.get(agentId);
        if (queue) {
          const idx = queue.indexOf(entry);
          if (idx !== -1) {
            queue.splice(idx, 1);
          }
          if (queue.length === 0) {
            this.waitQueues.delete(agentId);
          }
        }

        log.warn(
          `a2a-concurrency: timeout for flow ${flowId} on agent ${agentId} ` +
            `after ${this.config.queueTimeoutMs}ms`,
        );

        reject(
          new A2AConcurrencyError(
            agentId,
            flowId,
            this.active.get(agentId) ?? 0,
            this.config.queueTimeoutMs,
          ),
        );
      }, this.config.queueTimeoutMs);

      entry = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        timer,
      };

      const queue = this.waitQueues.get(agentId) ?? [];
      queue.push(entry);
      this.waitQueues.set(agentId, queue);
    });

    // Permit was already transferred by release() — no need to increment active count.
  }

  release(agentId: string, _flowId: string): void {
    // Wake next queued flow — transfer the permit directly without
    // decrementing first, preventing a window where a new acquire()
    // could slip in and exceed maxConcurrentFlows.
    const queue = this.waitQueues.get(agentId);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) {
        this.waitQueues.delete(agentId);
      }
      next.resolve();
      return;
    }

    // No waiters — decrement active count
    const current = this.active.get(agentId) ?? 0;
    if (current > 0) {
      this.active.set(agentId, current - 1);
      if (current - 1 === 0) {
        this.active.delete(agentId);
      }
    }
  }

  activeCount(agentId: string): number {
    return this.active.get(agentId) ?? 0;
  }

  queuedCount(agentId: string): number {
    return this.waitQueues.get(agentId)?.length ?? 0;
  }
}

// ---------- Module-level singleton ----------

let globalGate: A2AConcurrencyGate | null = null;

/** Initialize the global A2A concurrency gate. Call once at gateway startup. */
export function initA2AConcurrencyGate(config?: Partial<A2AConcurrencyConfig>): void {
  const resolved: A2AConcurrencyConfig = {
    ...DEFAULT_A2A_CONCURRENCY_CONFIG,
    ...config,
  };
  globalGate = new A2AConcurrencyGateImpl(resolved);
  log.info(
    `a2a-concurrency: initialized (maxConcurrentFlows=${resolved.maxConcurrentFlows}, queueTimeoutMs=${resolved.queueTimeoutMs})`,
  );
}

/** Get the global A2A concurrency gate. Returns null if not initialized. */
export function getA2AConcurrencyGate(): A2AConcurrencyGate | null {
  return globalGate;
}

/** Reset the global gate (for testing). */
export function resetA2AConcurrencyGate(): void {
  globalGate = null;
}
