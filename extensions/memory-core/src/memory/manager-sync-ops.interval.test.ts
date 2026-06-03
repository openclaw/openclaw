import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

type MemoryIndexEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content?: string;
};

class IntervalSyncHarness extends MemoryManagerSyncOps {
  protected readonly cfg = {} as OpenClawConfig;
  protected readonly agentId = "main";
  protected readonly workspaceDir = "/tmp/openclaw-memory-interval-test";
  protected readonly settings: ResolvedMemorySearchConfig;
  protected readonly batch = {
    enabled: false,
    wait: false,
    concurrency: 1,
    pollIntervalMs: 0,
    timeoutMs: 0,
  };
  protected readonly vector = { enabled: false, available: false };
  protected readonly cache = { enabled: false };
  protected providerUnavailableReason?: string;
  protected providerLifecycle = { mode: "active" as const, providerId: "test" };
  protected db = {} as DatabaseSync;

  constructor(params: { intervalMinutes?: number; batchTimeoutMinutes?: number }) {
    super();
    this.settings = {
      sync: { intervalMinutes: params.intervalMinutes ?? 0 },
      remote: {
        batch: {
          enabled: true,
          timeoutMinutes: params.batchTimeoutMinutes,
        },
      },
    } as ResolvedMemorySearchConfig;
  }

  arm(): void {
    this.ensureIntervalSync();
  }

  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  batchConfig(): ReturnType<MemoryManagerSyncOps["resolveBatchConfig"]> {
    return this.resolveBatchConfig();
  }

  protected computeProviderKey(): string {
    return "test";
  }

  async sync(): Promise<void> {}

  /** Public accessor for test assertions on the protected parent dirty state. */
  get isDirty(): boolean {
    return this.dirty;
  }

  protected async withTimeout<T>(promise: Promise<T>): Promise<T> {
    return await promise;
  }

  protected getIndexConcurrency(): number {
    return 1;
  }

  protected pruneEmbeddingCacheIfNeeded(): void {}

  protected resetProviderInitializationForRetry(): void {}

  protected async indexFile(
    _entry: MemoryIndexEntry,
    _options: { source: MemorySource; content?: string },
  ): Promise<void> {}
}

describe("MemoryManagerSyncOps interval sync", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clamps oversized interval sync timers", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const harness = new IntervalSyncHarness({ intervalMinutes: Number.MAX_SAFE_INTEGER });

    harness.arm();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    harness.stop();
  });

  it("clamps oversized batch timeout minutes", () => {
    const harness = new IntervalSyncHarness({
      batchTimeoutMinutes: Number.MAX_SAFE_INTEGER,
    });

    expect(harness.batchConfig().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("sets dirty=true and calls sync when interval fires", async () => {
    vi.useFakeTimers();
    const harness = new IntervalSyncHarness({ intervalMinutes: 5 });
    const syncSpy = vi.spyOn(harness, "sync").mockResolvedValue(undefined);

    harness.arm();

    // Advance past the interval
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(harness.isDirty).toBe(true);
    expect(syncSpy).toHaveBeenCalledWith({ reason: "interval" });
    harness.stop();
  });
});
