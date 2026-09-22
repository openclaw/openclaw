// Memory Core plugin module implements manager runtime behavior.
import { getMemoryIndexManagerRegistry, MemoryIndexManager } from "./manager.js";

export { MemoryIndexManager };

export async function closeAllMemoryIndexManagers(): Promise<void> {
  const registry = getMemoryIndexManagerRegistry();
  registry.embeddingProbeCache.clear();
  await registry.closeAll();
}

export async function closeMemoryIndexManagersForAgent(params: { agentId: string }): Promise<void> {
  const registry = getMemoryIndexManagerRegistry();
  for (const purpose of ["default", "maintenance"] as const) {
    await registry.closeForAgent({ ...params, purpose });
  }
}
