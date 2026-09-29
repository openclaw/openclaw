import type { MemoryIndexWorkItem } from "./manager-sync-base.js";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

// Source scheduling fixtures do not acquire embedding-provider generations.
export abstract class MemorySyncTestHarness extends MemoryManagerSyncOps {
  protected beginSyncProviderGeneration(): void {}
  protected endSyncProviderGeneration(): void {}

  protected async retireCurrentProvider(): Promise<void> {
    throw new Error("Source sync harness does not own embedding providers");
  }

  protected async indexFiles(items: MemoryIndexWorkItem[]): Promise<void> {
    for (const item of items) {
      await this.indexFile(item.entry, { source: item.source });
    }
  }
}
