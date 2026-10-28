import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import type { MemoryIndexWorkItem } from "./manager-sync-base.js";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

// Source scheduling fixtures do not acquire embedding-provider generations.
export abstract class MemorySyncTestHarness extends MemoryManagerSyncOps {
  protected readonly createProvider = (): never => {
    throw new Error("Source sync harness does not acquire embedding providers");
  };
  protected readonly agentId = "main";
  protected readonly workspaceDir: string = "/tmp/openclaw-test-workspace";
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
  protected computeProviderKey = () => "test";
  protected resolveProviderIndexIdentities = () => [];
  protected withTimeout = async <T>(promise: Promise<T>): Promise<T> => await promise;
  protected async pruneEmbeddingCacheIfNeeded(): Promise<void> {}
  protected resetProviderInitializationForRetry(): void {}
  protected assertRequiredProviderAvailable(): void {}

  protected readonly runInBackgroundContext = runInMemoryTestBackgroundContext;
  protected beginSyncProviderGeneration(): void {}
  protected endSyncProviderGeneration(): void {}

  protected async syncBackground(params: MemorySyncParams): Promise<void> {
    this.syncIsBackground = true;
    try {
      await this.sync(params);
    } finally {
      this.syncIsBackground = false;
    }
  }

  protected async retireCurrentProvider(): Promise<void> {
    throw new Error("Source sync harness does not own embedding providers");
  }

  protected async indexFiles(items: MemoryIndexWorkItem[]): Promise<MemoryIndexWorkItem[]> {
    for (const item of items) {
      await this.indexFile(item.entry, item.source);
    }
    return [];
  }
}
