import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginLogger } from "../../api.js";
import type { PendingTask } from "./types.js";

/**
 * Durable registry of async tasks awaiting completion notification.
 *
 * In-memory map mirrored to a single JSON file under the plugin stateDir, so a
 * gateway restart resumes pending polls instead of dropping them (the failure
 * mode the in-memory RecentTaskStore has). Writes are atomic (temp + rename)
 * and serialized through a single in-flight promise to avoid interleaving.
 */
export class PendingTaskRegistry {
  private readonly tasks = new Map<string, PendingTask>();
  private filePath: string | null = null;
  private logger: PluginLogger | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private initialized = false;

  /** Load persisted tasks and enable persistence. Idempotent. */
  async init(filePath: string, logger: PluginLogger): Promise<void> {
    this.filePath = filePath;
    this.logger = logger;
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const task = item as PendingTask;
          if (task && typeof task.id === "string") {
            this.tasks.set(task.id, task);
          }
        }
      }
      logger.info(`[LEADING_V2_NOTIFY] Loaded ${this.tasks.size} pending task(s) from ${filePath}`);
    } catch (error) {
      // Missing file on first run is expected; anything else is logged and ignored (start clean).
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn(`[LEADING_V2_NOTIFY] Could not read pending store: ${String(error)}`);
      }
    }
  }

  add(task: PendingTask): void {
    this.tasks.set(task.id, task);
    void this.persist();
  }

  update(id: string, patch: Partial<PendingTask>): void {
    const existing = this.tasks.get(id);
    if (!existing) {
      return;
    }
    this.tasks.set(id, { ...existing, ...patch });
    void this.persist();
  }

  remove(id: string): void {
    if (this.tasks.delete(id)) {
      void this.persist();
    }
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  all(): PendingTask[] {
    return [...this.tasks.values()];
  }

  /** Drop expired tasks; returns how many were pruned. */
  prune(now: number): number {
    let pruned = 0;
    for (const task of this.tasks.values()) {
      if (task.expiresAt <= now) {
        this.tasks.delete(task.id);
        pruned++;
      }
    }
    if (pruned > 0) {
      void this.persist();
    }
    return pruned;
  }

  /** Flush any pending write (call on shutdown). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * Reset to uninitialized state — test-only, so a global singleton doesn't leak
   * across test files.
   */
  resetForTest(): void {
    this.tasks.clear();
    this.filePath = null;
    this.initialized = false;
  }

  private persist(): Promise<void> {
    if (!this.filePath) {
      return Promise.resolve();
    }
    const filePath = this.filePath;
    // Snapshot now so the queued write serializes a consistent view.
    const snapshot = JSON.stringify([...this.tasks.values()]);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(dirname(filePath), { recursive: true });
        const tmp = join(dirname(filePath), `.${Date.now()}-${Math.round(performance.now())}.tmp`);
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, filePath);
      } catch (error) {
        this.logger?.warn(`[LEADING_V2_NOTIFY] Failed to persist pending store: ${String(error)}`);
      }
    });
    return this.writeChain;
  }
}

// Plugin register(api) may run more than once in a process (separate registries
// for tool discovery vs service startup). In-memory state created inside the
// register() closure would NOT be shared, so the tool would enqueue into one
// registry while the notifier polls another. Pin a single instance on globalThis.
const REGISTRY_SYMBOL = Symbol.for("openclaw.leading-v2.pendingTaskRegistry");

export function getSharedPendingRegistry(): PendingTaskRegistry {
  const g = globalThis as unknown as Record<symbol, PendingTaskRegistry | undefined>;
  let registry = g[REGISTRY_SYMBOL];
  if (!registry) {
    registry = new PendingTaskRegistry();
    g[REGISTRY_SYMBOL] = registry;
  }
  return registry;
}
