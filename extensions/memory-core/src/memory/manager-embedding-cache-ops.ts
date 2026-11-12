import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  hasNonTextEmbeddingParts,
  type EmbeddingInput,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
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
import type { MemoryIndexWorkItem, MemorySemanticProviderGeneration } from "./manager-sync-base.js";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

type MemoryIndexEntry = MemoryIndexWorkItem["entry"];

const CACHE_READ_PAGE_BYTES = 8 * 1024 * 1024;
const CACHE_READ_DEFAULT_DIMENSIONS = 4096;

export type MemoryEmbeddingCacheCandidate = {
  chunk: IndexedMemoryChunk;
  entry: MemoryIndexEntry;
  source: MemorySource;
};

export type MemoryCachedEmbeddings = {
  embeddings: number[][];
  missing: number[];
  missingCandidates: MemoryEmbeddingCacheCandidate[];
};

export abstract class MemoryManagerEmbeddingCacheOps extends MemoryManagerSyncOps {
  protected abstract embedBatchWithRetry(
    inputs: Array<string | EmbeddingInput>,
    generation?: MemorySemanticProviderGeneration,
    cacheCandidates?: MemoryEmbeddingCacheCandidate[],
  ): Promise<number[][]>;

  protected async pruneEmbeddingCacheIfNeeded(recount = false): Promise<void> {
    const max = this.cache.maxEntries;
    if (!this.cache.enabled || !max || max <= 0) {
      return;
    }
    const database = this.database;
    const assertCurrent = () => {
      if (this.closed || !database.isOpen || this.database !== database) {
        throw new Error("Memory database owner closed or changed before write admission");
      }
    };
    const unreferencedFirst = {
      identities: this.syncProviderGeneration?.identities ?? this.resolveProviderIndexIdentities(),
    };
    // Deletion may fence new writes before close. Stop optional maintenance between
    // batches so retiring a suspended rebuild only drains and releases its resources.
    while (
      !this.closing &&
      (await database.pruneEmbeddingCache(
        { maxEntries: max, unreferencedFirst, ...(recount ? { recount: true } : {}) },
        assertCurrent,
      ))
    ) {
      await yieldToEventLoop();
    }
  }

  protected async collectCachedEmbeddings(
    candidates: MemoryEmbeddingCacheCandidate[],
    generation: MemorySemanticProviderGeneration,
  ) {
    const hashes = candidates.map((candidate) => candidate.chunk.hash);
    const meta = generation.database.facts.meta;
    // Only the published index can bind an alias to this vector space.
    const providerIdentities = generation.identities.filter(
      (identity, index) =>
        index === 0 ||
        (identity.provider === meta?.provider &&
          identity.model === meta.model &&
          identity.providerKey === meta.providerKey),
    );
    const published = new Map<
      string,
      Array<{ source: MemorySource; path: string; hash: string }>
    >();
    for (const { source, entry, chunk } of candidates) {
      const chunks = published.get(chunk.hash);
      const ref = { source, path: entry.path, hash: chunk.hash };
      if (chunks) {
        chunks.push(ref);
      } else {
        published.set(chunk.hash, [ref]);
      }
    }
    // The read worker decodes each vector into 8 bytes per dimension under a bounded heap,
    // so a rebuild reads whole hashes in pages instead of every published vector at once.
    const pageHashes = Math.max(
      1,
      Math.floor(
        CACHE_READ_PAGE_BYTES /
          (8 *
            (generation.embeddingDimensions ?? meta?.vectorDims ?? CACHE_READ_DEFAULT_DIMENSIONS)),
      ),
    );
    const uniqueHashes = [...published.keys()];
    const cached = new Map<string, number[]>();
    for (let start = 0; start < uniqueHashes.length; start += pageHashes) {
      const page = uniqueHashes.slice(start, start + pageHashes);
      const read = await generation.database.read(
        {
          type: "cache.read",
          input: {
            providerIdentities,
            hashes: page,
            cacheEnabled: this.cache.enabled,
            published: {
              chunks: page.flatMap((hash) => published.get(hash) ?? []),
              dimensions: generation.embeddingDimensions,
            },
          },
        },
        () => {
          if (!generation.database.isOpen) {
            throw new Error("Memory database owner is closed");
          }
        },
      );
      // Cache hits and new batches must inhabit the same vector space during a sync.
      for (const [hash, embedding] of read) {
        if (isValidMemoryEmbedding(embedding, generation.embeddingDimensions)) {
          generation.embeddingDimensions ??= embedding.length;
          cached.set(hash, embedding);
        }
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
    prepared?: MemoryCachedEmbeddings,
  ): Promise<number[][]> {
    const { embeddings, missing, missingCandidates } =
      prepared ?? (await this.collectCachedEmbeddings(candidates, generation));

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
          !generation.database.isOpen ||
          this.database !== generation.database
        ) {
          throw new Error("Memory database owner closed or changed before write admission");
        }
      };
      // Rebuilds use a shadow index; cache writes retain the captured published owner.
      await generation.database.mutateEmbeddingCache(mutation, assertCurrent, () => {
        assertCurrent();
        return this.canWriteEmbeddingCache(generation);
      });
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
    if (candidates.length === 0 || !this.canWriteEmbeddingCache(generation)) {
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
        this.cache.enabled &&
        generation.embeddingDimensions !== undefined &&
        embeddings.some(
          (embedding) =>
            isValidMemoryEmbedding(embedding) &&
            embedding.length !== generation.embeddingDimensions,
        )
      ) {
        // Conflicting batches cannot share an identity's cache. Discard it so
        // retries can recover after restart, using the declared size when available.
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
    if (!this.cache.enabled) {
      return;
    }
    await withMemoryWorkspaceLock(this.workspaceDir, async () => {
      if (!this.canWriteEmbeddingCache(generation)) {
        return;
      }
      const accepted: MemoryEmbeddingCacheEntry[] = [];
      for (const [index, candidate] of candidates.entries()) {
        if (candidate.source === "sessions" && !candidate.entry.sessionId) {
          continue;
        }
        // Changed files may leave unused content-addressed vectors; normal cache eviction
        // removes them. The publication worker still checks session tombstones.
        accepted.push({
          hash: candidate.chunk.hash,
          embedding: embeddings[index] ?? [],
          ...(candidate.source === "sessions" ? { sessionId: candidate.entry.sessionId } : {}),
        });
      }
      if (accepted.length === 0) {
        return;
      }
      const reindex = this.reindexProgress;
      if (reindex) {
        reindex.cachePrunePending = true;
      }
      await this.withGeneratedEmbeddingCacheWrite(generation, {
        kind: "upsert",
        header: {
          agentId: this.agentId,
          provider: { id: generation.provider.id, model: generation.provider.model },
          providerKey: generation.providerKey,
          // Rebuilds reserve at most 2× maxEntries. Live completion/abort trims to
          // the cap; retirement leaves this bounded cache for later admitted writes.
          maxEntries:
            this.cache.maxEntries === undefined
              ? undefined
              : this.cache.maxEntries * (this.reindexProgress ? 2 : 1),
          unreferencedFirst: { identities: generation.identities },
        },
        entries: accepted,
      });
    });
  }
}
