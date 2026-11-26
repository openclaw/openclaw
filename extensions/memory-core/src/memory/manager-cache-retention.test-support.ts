import { onTestFinished, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";

/**
 * Cases that read generated vectors back from the cache as a probe keep the rows a
 * publication already serves; manager-embedding-cache-retire.test.ts covers retirement.
 */
export function keepPublishedCacheDuplicates() {
  const spy = vi
    .spyOn(MemoryIndexDatabase.prototype, "retireEmbeddingCache")
    .mockResolvedValue(null);
  onTestFinished(() => spy.mockRestore());
  return spy;
}
