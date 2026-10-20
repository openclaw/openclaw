// Memory Core tests cover resolved batch timeout bounds.
import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { MemorySyncTestHarness } from "./manager-sync-ops.test-support.js";

type MemoryIndexEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content?: string;
};

class BatchTimeoutHarness extends MemorySyncTestHarness {
  readonly sync = vi.fn(async () => {});
  protected readonly createProvider = (): never => {
    throw new Error("Batch timeout harness does not acquire embedding providers");
  };
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
  protected readonly cache = { enabled: false };
  protected providerUnavailableReason?: string;
  protected providerLifecycle = { mode: "active" as const, providerId: "test" };
  protected publishedDatabase = new MemoryIndexDatabase({} as DatabaseSync);

  constructor(params: { batchTimeoutMinutes: number }) {
    super();
    this.settings = {
      remote: {
        batch: {
          enabled: true,
          timeoutMinutes: params.batchTimeoutMinutes,
        },
      },
    } as ResolvedMemorySearchConfig;
  }

  batchConfig(): ReturnType<MemorySyncTestHarness["resolveBatchConfig"]> {
    return this.resolveBatchConfig();
  }

  protected computeProviderKey(): string {
    return "test";
  }

  protected resolveProviderIndexIdentities() {
    return [];
  }

  protected async withTimeout<T>(promise: Promise<T>): Promise<T> {
    return await promise;
  }

  protected getIndexConcurrency(): number {
    return 1;
  }

  protected async pruneEmbeddingCacheIfNeeded(): Promise<void> {}

  protected resetProviderInitializationForRetry(): void {}

  protected assertRequiredProviderAvailable(): void {}

  protected async indexFile(_entry: MemoryIndexEntry, _source: MemorySource): Promise<void> {}
}

describe("MemoryManagerSyncOps batch timeout", () => {
  it("clamps oversized batch timeout minutes", () => {
    const harness = new BatchTimeoutHarness({
      batchTimeoutMinutes: Number.MAX_SAFE_INTEGER,
    });

    expect(harness.batchConfig().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
