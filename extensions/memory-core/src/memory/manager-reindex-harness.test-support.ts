import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingProvider } from "./embeddings.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";

export type SyncArchiveParams = { needsFullReindex: boolean; targetArchiveFiles?: string[] };

export type ReindexHarness = {
  sync: (params: { reason?: string; force?: boolean }) => Promise<void>;
  syncArchiveFiles: (params: SyncArchiveParams) => Promise<unknown>;
  db: DatabaseSync;
  cache: { enabled: boolean; maxEntries?: number };
  getIndexConcurrency: () => number;
  syncProviderGeneration: unknown;
  writeMeta: (meta: MemoryIndexMeta) => Promise<void>;
  providerKey: string | null;
  provider: EmbeddingProvider | null;
  dirty: boolean;
  memoryFullRetryDirty: boolean;
  sessionsDirty: boolean;
  sessionsFullRetryDirty: boolean;
  sessionsDirtyFiles: Set<string>;
};
