import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  hasNonTextEmbeddingParts,
  type EmbeddingInput,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  buildFileEntry,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { withMemoryWorkspaceLock } from "../memory-workspace-lock.js";
import type { IndexedMemoryChunk } from "./manager-chunk-writer.js";
import {
  collectMemoryCachedEmbeddings,
  isValidMemoryEmbedding,
} from "./manager-embedding-cache.js";
import { buildMemoryEmbeddingBatches } from "./manager-embedding-policy.js";
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
  protected abstract embedBatchWithRetry(
    inputs: Array<string | EmbeddingInput>,
    generation?: MemorySemanticProviderGeneration,
    cacheCandidates?: MemoryEmbeddingCacheCandidate[],
  ): Promise<number[][]>;

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

  protected assertEmbeddingCacheGenerationCurrent(
    generation: MemorySemanticProviderGeneration,
  ): void {
    if (
      this.closed ||
      this.syncProviderGeneration !== generation ||
      generation.database.closed ||
      !generation.database.db.isOpen ||
      this.publishedDatabase !== generation.database
    ) {
      throw new Error("Memory embedding generation changed during cache lookup");
    }
  }

  protected async collectCachedEmbeddings(
    candidates: MemoryEmbeddingCacheCandidate[],
    generation: MemorySemanticProviderGeneration,
  ) {
    const hashes = candidates.map((candidate) => candidate.chunk.hash);
    const cached = this.cache.enabled
      ? await generation.database.read(
          {
            type: "cache.read",
            input: {
              providerIdentities: generation.identities,
              hashes,
            },
          },
          () => this.assertEmbeddingCacheGenerationCurrent(generation),
        )
      : new Map<string, number[]>();
    this.assertEmbeddingCacheGenerationCurrent(generation);
    // Cache hits and new batches must inhabit the same vector space during a sync.
    for (const [hash, embedding] of cached) {
      if (!isValidMemoryEmbedding(embedding, generation.embeddingDimensions)) {
        cached.delete(hash);
      } else {
        generation.embeddingDimensions ??= embedding.length;
      }
    }
    const result = collectMemoryCachedEmbeddings({ hashes, cached });
    return {
      ...result,
      missingCandidates: result.missing.map((index) =>
        expectDefined(candidates[index], "missing memory embedding candidate"),
      ),
    };
  }

  protected async embedChunksInBatches(
    candidates: MemoryEmbeddingCacheCandidate[],
    generation: MemorySemanticProviderGeneration,
    maxTokens: number,
  ): Promise<number[][]> {
    const { embeddings, missing, missingCandidates } = await this.collectCachedEmbeddings(
      candidates,
      generation,
    );
    this.assertEmbeddingCacheGenerationCurrent(generation);

    if (missing.length === 0) {
      return embeddings;
    }

    const batches = buildMemoryEmbeddingBatches(
      missingCandidates.map((candidate) => candidate.chunk),
      maxTokens,
    );
    let cursor = 0;
    for (const batchChunks of batches) {
      const batchCandidates = missingCandidates.slice(cursor, cursor + batchChunks.length);
      const inputs = batchChunks.map((chunk) => chunk.embeddingInput ?? { text: chunk.text });
      const hasStructuredInputs = inputs.some((input) => hasNonTextEmbeddingParts(input));
      const batchEmbeddings = await this.embedBatchWithRetry(
        hasStructuredInputs ? inputs : batchChunks.map((chunk) => chunk.text),
        generation,
        batchCandidates,
      );
      for (let i = 0; i < batchChunks.length; i += 1) {
        const item = missing[cursor + i];
        const embedding = batchEmbeddings[i] ?? [];
        if (item !== undefined) {
          embeddings[item] = embedding;
        }
      }
      cursor += batchChunks.length;
    }
    return embeddings;
  }

  private async withGeneratedEmbeddingCacheWrite(
    generation: MemorySemanticProviderGeneration,
    mutation: MemoryEmbeddingCacheMutation,
  ): Promise<void> {
    await this.withPublishedDatabase(async () => {
      if (!this.canWriteEmbeddingCache(generation) || this.database !== generation.database) {
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
          return this.canWriteEmbeddingCache(generation) ? generation.databaseRevision : undefined;
        },
        () => {
          generation.cacheWritesInvalidated = true;
        },
      );
    });
  }

  private canWriteEmbeddingCache(generation: MemorySemanticProviderGeneration): boolean {
    return (
      this.syncProviderGeneration === generation &&
      !generation.cacheWritesInvalidated &&
      !generation.database.closed
    );
  }

  protected async persistGeneratedEmbeddings(
    candidates: MemoryEmbeddingCacheCandidate[],
    embeddings: number[][],
    generation: MemorySemanticProviderGeneration,
  ): Promise<void> {
    if (
      !this.cache.enabled ||
      candidates.length === 0 ||
      !this.canWriteEmbeddingCache(generation)
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
      const position = embeddings.findIndex(
        (embedding) => !isValidMemoryEmbedding(embedding, dimensions),
      );
      const embedding = embeddings[position];
      let condition = `expected ${candidates.length} vectors, got ${embeddings.length}`;
      if (embeddings.length === candidates.length) {
        if (!Array.isArray(embedding)) {
          condition = `missing embedding array at position ${position}`;
        } else if (embedding.length === 0) {
          condition = `empty embedding at position ${position}`;
        } else if (embedding.length !== dimensions) {
          condition = `expected ${dimensions} dimensions, got ${embedding.length} at position ${position}`;
        } else {
          condition = `non-finite or non-numeric coordinate at position ${position}`;
        }
      }
      throw new Error(
        `${generation.provider.id} embeddings failed (model: ${generation.provider.model}, batch size: ${candidates.length}): ${condition}`,
      );
    }
    generation.embeddingDimensions = dimensions;
    await withMemoryWorkspaceLock(this.workspaceDir, async () => {
      if (!this.canWriteEmbeddingCache(generation)) {
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
