import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  buildFileEntry,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { withMemoryWorkspaceLock } from "../memory-workspace-lock.js";
import type { IndexedMemoryChunk } from "./manager-chunk-writer.js";
import {
  collectMemoryCachedEmbeddings,
  isValidMemoryEmbedding,
  loadMemoryEmbeddingCache,
} from "./manager-embedding-cache.js";
import type {
  MemoryEmbeddingCacheEntry,
  MemoryEmbeddingCacheMutation,
} from "./manager-publication-task.js";
import {
  MemoryManagerSyncOps,
  type MemoryIndexWorkItem,
  type MemorySemanticProviderGeneration,
} from "./manager-sync-ops.js";

type MemoryIndexEntry = MemoryIndexWorkItem["entry"];

export type MemoryEmbeddingCacheCandidate = {
  chunk: IndexedMemoryChunk;
  entry: MemoryIndexEntry;
  source: MemorySource;
};

export abstract class MemoryManagerEmbeddingCacheOps extends MemoryManagerSyncOps {
  protected async pruneEmbeddingCacheIfNeeded(): Promise<void> {
    const max = this.cache.maxEntries;
    if (!this.cache.enabled || !max || max <= 0) {
      return;
    }
    const database = this.database;
    const assertCurrent = () => {
      if (this.closed || database.closed || !database.db.isOpen || this.database !== database) {
        throw new Error("Memory database owner closed or changed before write admission");
      }
    };
    while (await database.pruneEmbeddingCache(max, assertCurrent)) {
      await yieldToEventLoop();
    }
  }

  protected collectCachedEmbeddings(
    candidates: MemoryEmbeddingCacheCandidate[],
    generation: MemorySemanticProviderGeneration,
  ) {
    const chunks = candidates.map((candidate) => candidate.chunk);
    const cached = loadMemoryEmbeddingCache({
      db: generation.database.db,
      enabled: this.cache.enabled,
      providerIdentities: generation.identities,
      hashes: chunks.map((chunk) => chunk.hash),
    });
    // Cache hits and new batches must inhabit the same vector space during a sync.
    for (const [hash, embedding] of cached) {
      if (!isValidMemoryEmbedding(embedding, generation.embeddingDimensions)) {
        cached.delete(hash);
      } else {
        generation.embeddingDimensions ??= embedding.length;
      }
    }
    const result = collectMemoryCachedEmbeddings({ chunks, cached });
    return {
      ...result,
      missingCandidates: result.missing.map((item) =>
        expectDefined(candidates[item.index], "missing memory embedding candidate"),
      ),
    };
  }

  private async withGeneratedEmbeddingCacheWrite(
    generation: MemorySemanticProviderGeneration,
    mutation: MemoryEmbeddingCacheMutation,
  ): Promise<void> {
    await this.withPublishedDatabase(async () => {
      if (
        this.syncProviderGeneration !== generation ||
        generation.cacheWritesInvalidated ||
        generation.database.closed ||
        this.database !== generation.database
      ) {
        return;
      }
      const assertCurrent = () => {
        if (
          this.closed ||
          generation.database.closed ||
          !generation.database.db.isOpen ||
          this.database !== generation.database
        ) {
          throw new Error("Memory database owner closed or changed before write admission");
        }
      };
      // Rebuilds use a shadow index; cache writes retain the captured published owner.
      await generation.database.mutateEmbeddingCache(
        mutation,
        assertCurrent,
        () => {
          assertCurrent();
          if (
            this.syncProviderGeneration !== generation ||
            generation.cacheWritesInvalidated ||
            generation.database.closed
          ) {
            return undefined;
          }
          return generation.databaseRevision;
        },
        () => {
          generation.cacheWritesInvalidated = true;
        },
      );
    });
  }

  protected async persistGeneratedEmbeddings(
    candidates: MemoryEmbeddingCacheCandidate[],
    embeddings: number[][],
    generation: MemorySemanticProviderGeneration,
  ): Promise<void> {
    if (
      !this.cache.enabled ||
      candidates.length === 0 ||
      this.syncProviderGeneration !== generation ||
      generation.cacheWritesInvalidated ||
      generation.database.closed
    ) {
      return;
    }
    // Validate the whole provider response before retaining any vectors. Index
    // insertion can fail later, but must never leave a reusable malformed batch.
    const dimensions = generation.embeddingDimensions ?? embeddings[0]?.length;
    if (
      embeddings.length !== candidates.length ||
      !embeddings.every((embedding) => isValidMemoryEmbedding(embedding, dimensions))
    ) {
      if (
        generation.embeddingDimensions !== undefined &&
        embeddings.some(
          (embedding) =>
            isValidMemoryEmbedding(embedding) &&
            embedding.length !== generation.embeddingDimensions,
        )
      ) {
        // Separate successful batches can disagree. Neither dimension is authoritative;
        // discard this identity's ambiguous cache so retries can recover after restart.
        await withMemoryWorkspaceLock(this.workspaceDir, async () => {
          try {
            await this.withGeneratedEmbeddingCacheWrite(generation, {
              kind: "clear",
              identities: generation.identities,
            });
          } finally {
            // Worker admission can fail before its callback publishes this known conflict.
            generation.cacheWritesInvalidated = true;
          }
        });
      }
      throw new Error(
        "memory embeddings: malformed vector response (count, dimensions, or coordinates)",
      );
    }
    generation.embeddingDimensions = dimensions;
    await withMemoryWorkspaceLock(this.workspaceDir, async () => {
      if (
        this.syncProviderGeneration !== generation ||
        generation.cacheWritesInvalidated ||
        generation.database.closed
      ) {
        return;
      }
      const entryValidity = new Map<MemoryIndexEntry, boolean>();
      const accepted: MemoryEmbeddingCacheEntry[] = [];
      for (const [index, candidate] of candidates.entries()) {
        let valid = entryValidity.get(candidate.entry);
        if (valid === undefined) {
          if (candidate.source === "memory") {
            const current = await (this.memoryFiles?.inspectFile ?? buildFileEntry)(
              candidate.entry.absPath,
              this.workspaceDir,
              this.settings.multimodal,
            );
            valid = current?.hash === candidate.entry.hash;
          } else {
            const sessionId = candidate.entry.sessionId;
            valid = Boolean(sessionId);
          }
          entryValidity.set(candidate.entry, valid);
        }
        if (valid) {
          accepted.push({
            hash: candidate.chunk.hash,
            embedding: embeddings[index] ?? [],
            ...(candidate.source === "sessions" ? { sessionId: candidate.entry.sessionId } : {}),
          });
        }
      }
      if (accepted.length === 0) {
        return;
      }
      await this.withGeneratedEmbeddingCacheWrite(generation, {
        kind: "upsert",
        header: {
          agentId: this.agentId,
          provider: { id: generation.provider.id, model: generation.provider.model },
          providerKey: generation.providerKey,
          maxEntries: this.cache.maxEntries,
        },
        entries: accepted,
      });
    });
  }
}
