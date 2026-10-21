import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  formatEmbeddingModelInput,
  isEmbeddingBatchUnavailableError,
  resolveEmbeddingInputFormatVersion,
  type EmbeddingInput,
  type MemoryEmbeddingProviderRuntime,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  createMemorySearchDeadlineControl,
  MEMORY_SEARCH_DEADLINE_CONTROL,
  runWithConcurrency,
  type MemorySearchDeadlineControl,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import {
  withMemoryWorkspaceLock,
  withMemoryWorkspacePreparation,
} from "../memory-workspace-lock.js";
import { readSessionResetRecallCutoffMetadata } from "../session-reset-recall-metadata.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { IndexedMemoryChunk } from "./manager-chunk-writer.js";
import { prepareMemoryIndexInWorker } from "./manager-cpu-worker-runtime.js";
import {
  MemoryManagerEmbeddingCacheOps,
  type MemoryEmbeddingCacheCandidate,
  type MemoryCachedEmbeddings,
} from "./manager-embedding-cache-ops.js";
import { createMemoryEmbeddingOperationError } from "./manager-embedding-errors.js";
import {
  runMemoryEmbeddingBatchTimeoutRetry,
  runMemoryEmbeddingBatchRetryWithSplit,
  runMemoryEmbeddingRetryLoop,
} from "./manager-embedding-policy.js";
import { resolveChunkProvenance } from "./manager-index-preparation.js";
import { readMemoryIndexSource } from "./manager-index-source.js";
import { memoryPublicationGroup } from "./manager-publication-transfer.js";
import {
  resolveMemoryIndexProviderIdentities,
  type MemoryIndexProviderIdentity,
} from "./manager-reindex-state.js";
import {
  retainIndexedSessionChunks,
  type PreparedMemoryIndexEntry,
} from "./manager-session-delta.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";
import type {
  MemoryIndexWorkItem,
  MemorySemanticProviderGeneration,
  MemorySyncProviderGeneration,
} from "./manager-sync-ops.js";
import { logMemoryVectorDegradedWrite } from "./manager-vector-warning.js";
import { resolveMemoryPathClassification } from "./memory-path-provenance.js";
import { runEmbeddingOperationWithTimeout } from "./paused-deadline.js";

const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_TIMEOUTS_MS = {
  query: { remote: 60_000, local: 5 * 60_000 },
  batch: { remote: 2 * 60_000, local: 10 * 60_000 },
};
const SOURCE_PUBLICATION_MAX_FILES = 8;
const SOURCE_PUBLICATION_MAX_ROWS = 128;
const SOURCE_WIDE_BATCH_MAX_FILES = 2048;
const SOURCE_WIDE_BATCH_MAX_REQUESTS = 50000;

const log = createSubsystemLogger("memory");

type MemoryIndexEntry = MemoryIndexWorkItem["entry"];
type MemoryPreparedPublication = {
  prepared: PreparedMemoryIndexEntry;
  embeddings: number[][];
  vectorReady: boolean;
};

export abstract class MemoryManagerEmbeddingOps extends MemoryManagerEmbeddingCacheOps {
  protected readonly batchFailureLimit = 2;
  protected batchFailure: { count: number; lastError?: string; lastProvider?: string } = {
    count: 0,
  };
  protected abstract markLocalEmbeddingProviderDegraded(err: unknown): void;
  private readonly activeProviderUses = new Map<EmbeddingProvider, Set<Promise<void>>>();
  private syncProviderGenerationRelease: (() => void) | null = null;
  private syncProviderGenerationOwners = 0;

  protected acquireProviderUse(provider: EmbeddingProvider): () => void {
    const completion = createDeferred();
    const uses = this.activeProviderUses.get(provider) ?? new Set<Promise<void>>();
    uses.add(completion.promise);
    this.activeProviderUses.set(provider, uses);
    return () => {
      if (!uses.delete(completion.promise)) {
        return;
      }
      completion.resolve();
      if (uses.size === 0) {
        this.activeProviderUses.delete(provider);
      }
    };
  }

  protected async awaitProviderIdle(provider: EmbeddingProvider): Promise<void> {
    const uses = this.activeProviderUses.get(provider);
    if (uses) {
      await Promise.all(uses);
    }
  }

  protected override beginSyncProviderGeneration(options?: { forceFtsOnly?: boolean }): void {
    if (this.syncProviderGeneration) {
      this.syncProviderGenerationOwners += 1;
      return;
    }
    const provider = options?.forceFtsOnly ? null : this.provider;
    const runtime = provider ? this.providerRuntime : undefined;
    const identities = resolveMemoryIndexProviderIdentities({
      provider,
      cacheKeyData: runtime?.cacheKeyData,
      aliases: runtime?.indexIdentityAliases,
    });
    const generation = {
      database: this.database,
      cacheWritesInvalidated: false,
      providerKey: expectDefined(identities.at(0), "primary memory provider identity").providerKey,
      identities,
      ...(provider ? { embeddingDimensions: provider.dimensions } : {}),
    };
    this.syncProviderGeneration = provider
      ? { ...generation, kind: "semantic", provider, ...(runtime ? { runtime } : {}) }
      : { ...generation, kind: "fts-only", provider: null };
    this.syncProviderGenerationRelease = provider ? this.acquireProviderUse(provider) : null;
    this.syncProviderGenerationOwners = 1;
  }

  protected override endSyncProviderGeneration(): void {
    if (this.syncProviderGenerationOwners > 1) {
      this.syncProviderGenerationOwners -= 1;
      return;
    }
    this.syncProviderGenerationOwners = 0;
    this.syncProviderGeneration = null;
    this.syncProviderGenerationRelease?.();
    this.syncProviderGenerationRelease = null;
  }

  protected computeProviderKey(): string {
    return expectDefined(
      this.resolveProviderIndexIdentities().at(0),
      "primary memory provider identity",
    ).providerKey;
  }

  protected resolveProviderIndexIdentities(): MemoryIndexProviderIdentity[] {
    return resolveMemoryIndexProviderIdentities({
      provider: this.provider,
      cacheKeyData: this.providerRuntime?.cacheKeyData,
      aliases: this.providerRuntime?.indexIdentityAliases,
    });
  }

  private async embedChunksWithBatch(
    candidates: MemoryEmbeddingCacheCandidate[],
    source: string,
    generation: MemorySemanticProviderGeneration,
    debugContext: Record<string, unknown> = {},
    cached?: MemoryCachedEmbeddings,
  ): Promise<number[][]> {
    const provider = generation.provider;
    const batchEmbed = generation.runtime?.batchEmbed;
    if (!this.batch.enabled || !batchEmbed) {
      return this.embedChunksInBatches(candidates, generation, EMBEDDING_BATCH_MAX_TOKENS, cached);
    }
    const { embeddings, missing, missingCandidates } =
      cached ?? (await this.collectCachedEmbeddings(candidates, generation));
    if (missing.length === 0) {
      return embeddings;
    }

    const missingChunks = missingCandidates.map((candidate) => candidate.chunk);
    const batchResult = this.batch.enabled
      ? await runMemoryEmbeddingBatchTimeoutRetry({
          onRetry: () =>
            log.warn(`memory embeddings: ${provider.id} batch timed out; retrying once`),
          run: () =>
            batchEmbed({
              agentId: this.agentId,
              chunks: resolveEmbeddingInputFormatVersion(provider.model)
                ? missingChunks.map((chunk) => ({
                    ...chunk,
                    ...formatEmbeddingModelInput(chunk, provider.model, "document"),
                    ...(chunk.embeddingInput
                      ? {
                          embeddingInput: formatEmbeddingModelInput(
                            chunk.embeddingInput,
                            provider.model,
                            "document",
                          ),
                        }
                      : {}),
                  }))
                : missingChunks,
              wait: this.batch.wait,
              concurrency: this.batch.concurrency,
              pollIntervalMs: this.batch.pollIntervalMs,
              timeoutMs: this.batch.timeoutMs,
              debug: (message, data) =>
                log.debug(message, { ...data, source, chunks: candidates.length, ...debugContext }),
            }),
        })
      : null;
    let batchEmbeddings: number[][];
    // Completion accounting is synchronous: concurrent batches cannot interleave updates.
    if (batchResult?.kind === "success") {
      if (this.batchFailure.count > 0) {
        log.debug("memory embeddings: batch recovered; resetting failure count");
      }
      // An in-flight success clears failures without re-enabling disabled batching.
      this.batchFailure = { count: 0 };
      if (!batchResult.value) {
        return this.embedChunksInBatches(candidates, generation, EMBEDDING_BATCH_MAX_TOKENS, {
          embeddings,
          missing,
          missingCandidates,
        });
      }
      batchEmbeddings = batchResult.value;
      await this.persistGeneratedEmbeddings(missingCandidates, batchEmbeddings, generation);
    } else {
      if (batchResult) {
        const message = formatErrorMessage(batchResult.error);
        const forceDisable = isEmbeddingBatchUnavailableError(batchResult.error);
        if (this.batch.enabled) {
          const count =
            this.batchFailure.count +
            (forceDisable ? this.batchFailureLimit : batchResult.attempts);
          this.batchFailure = { count, lastError: message, lastProvider: provider.id };
          this.batch.enabled = !(forceDisable || count >= this.batchFailureLimit);
        }
        const suffix = this.batch.enabled ? "keeping batch enabled" : "disabling batch";
        log.warn(
          `memory embeddings: ${provider.id} batch failed (${this.batchFailure.count}/${this.batchFailureLimit}); ${suffix}; falling back to non-batch embeddings: ${message}`,
        );
      }
      return this.embedChunksInBatches(candidates, generation, EMBEDDING_BATCH_MAX_TOKENS, {
        embeddings,
        missing,
        missingCandidates,
      });
    }
    for (const [index, item] of missing.entries()) {
      embeddings[item] = batchEmbeddings[index] ?? [];
    }
    return embeddings;
  }

  protected override async embedBatchWithRetry(
    inputs: Array<string | EmbeddingInput>,
    generation?: MemorySemanticProviderGeneration,
    cacheCandidates?: MemoryEmbeddingCacheCandidate[],
  ): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    const provider = generation?.provider ?? this.provider;
    if (!provider) {
      throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
    }
    const structured = inputs.some((input) => typeof input !== "string");
    const label = structured ? "structured batch" : "batch";
    const requestItems = inputs.map((input, index) => ({
      input,
      cacheCandidate: cacheCandidates?.[index],
    }));
    try {
      return await runMemoryEmbeddingBatchRetryWithSplit({
        items: requestItems,
        maxInputsPerRequest: provider.maxInputsPerRequest,
        run: async (batchItems) => {
          const timeoutMs = this.resolveEmbeddingTimeout("batch", provider, generation?.runtime);
          log.debug(`memory embeddings: ${label} start`, {
            provider: provider.id,
            items: batchItems.length,
            timeoutMs,
          });
          const result = await runEmbeddingOperationWithTimeout({
            timeoutMs,
            message: `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
            run: async (signal) =>
              await provider.embedBatch(
                batchItems.map((item) =>
                  formatEmbeddingModelInput(item.input, provider.model, "document"),
                ),
                { signal, inputType: "document" },
              ),
          });
          if (!structured) {
            log.debug("memory embeddings: batch completed", {
              provider: provider.id,
              items: batchItems.length,
            });
          }
          return result;
        },
        onSuccess: async (batchItems, batchEmbeddings) => {
          if (!generation) {
            return;
          }
          const batchCandidates = batchItems.flatMap((item) =>
            item.cacheCandidate ? [item.cacheCandidate] : [],
          );
          if (batchCandidates.length !== batchItems.length) {
            return;
          }
          await this.persistGeneratedEmbeddings(batchCandidates, batchEmbeddings, generation);
        },
        waitForRetry: async (delayMs) => {
          await this.waitForEmbeddingRetry(
            delayMs,
            structured ? "retrying structured batch" : "retrying",
          );
        },
        onSplit: ({ itemCount, splitAt }) => {
          log.warn(
            `memory embeddings ${label} failed; splitting ${itemCount} inputs into ${Math.ceil(itemCount / splitAt)} batches of at most ${splitAt}`,
          );
        },
      });
    } catch (err) {
      if (!structured) {
        log.debug("memory embeddings: batch failed", {
          provider: provider.id,
          error: formatErrorMessage(err),
        });
      }
      this.markLocalEmbeddingProviderDegraded(err);
      throw createMemoryEmbeddingOperationError({
        operation: structured ? "structured-batch" : "batch",
        providerId: provider.id,
        cause: err,
      });
    }
  }

  private async waitForEmbeddingRetry(
    delayMs: number,
    action: string,
    signal?: AbortSignal,
  ): Promise<void> {
    log.warn(`memory embeddings retryable error; ${action} in ${delayMs}ms`);
    await sleepWithAbort(delayMs, signal);
  }

  private resolveEmbeddingTimeout(
    kind: "query" | "batch",
    provider: EmbeddingProvider | null = this.provider,
    providerRuntime: MemoryEmbeddingProviderRuntime | undefined = this.providerRuntime,
  ): number {
    const defaults = EMBEDDING_TIMEOUTS_MS[kind];
    const runtimeTimeoutMs =
      kind === "query"
        ? providerRuntime?.inlineQueryTimeoutMs
        : providerRuntime?.inlineBatchTimeoutMs;
    return typeof runtimeTimeoutMs === "number" && runtimeTimeoutMs > 0
      ? resolveTimerTimeoutMs(runtimeTimeoutMs, defaults.remote)
      : defaults[provider?.id === "local" ? "local" : "remote"];
  }

  protected async probeEmbeddingProvider(
    provider: EmbeddingProvider,
    providerRuntime: MemoryEmbeddingProviderRuntime | undefined,
  ): Promise<void> {
    const timeoutMs = this.resolveEmbeddingTimeout("query", provider, providerRuntime);
    const deadlineControl = createMemorySearchDeadlineControl();
    try {
      await runEmbeddingOperationWithTimeout({
        timeoutMs,
        message: `memory embedding probe timed out after ${Math.round(timeoutMs / 1000)}s`,
        deadlineControl,
        run: (signal) =>
          provider.embed(formatEmbeddingModelInput("ping", provider.model, "query"), {
            signal,
            inputType: "query",
            [MEMORY_SEARCH_DEADLINE_CONTROL]: deadlineControl,
          }),
      });
    } catch (error) {
      if (provider === this.provider) {
        this.markLocalEmbeddingProviderDegraded(error);
      }
      throw error;
    }
  }

  protected async embedQueryWithRetry(
    text: string,
    signal?: AbortSignal,
    providerOverride?: EmbeddingProvider,
    providerRuntimeOverride?: MemoryEmbeddingProviderRuntime,
    deadlineControl?: MemorySearchDeadlineControl,
  ): Promise<number[]> {
    const provider = providerOverride ?? this.provider;
    const providerRuntime = providerOverride ? providerRuntimeOverride : this.providerRuntime;
    if (!provider) {
      throw new Error("Cannot embed query in FTS-only mode (no embedding provider)");
    }
    try {
      return await runMemoryEmbeddingRetryLoop({
        profile: "query",
        run: async () => {
          signal?.throwIfAborted();
          const timeoutMs = this.resolveEmbeddingTimeout("query", provider, providerRuntime);
          log.debug("memory embeddings: query start", { provider: provider.id, timeoutMs });
          return await runEmbeddingOperationWithTimeout({
            timeoutMs,
            message: `memory embeddings query timed out after ${Math.round(timeoutMs / 1000)}s`,
            signal,
            deadlineControl,
            run: async (opSignal) =>
              await provider.embed(formatEmbeddingModelInput(text, provider.model, "query"), {
                signal: opSignal,
                inputType: "query",
                ...(deadlineControl ? { [MEMORY_SEARCH_DEADLINE_CONTROL]: deadlineControl } : {}),
              }),
          });
        },
        signal,
        waitForRetry: async (delayMs) => {
          await this.waitForEmbeddingRetry(delayMs, "retrying query", signal);
        },
      });
    } catch (err) {
      throw createMemoryEmbeddingOperationError({
        operation: "query",
        providerId: provider.id,
        cause: err,
      });
    }
  }

  protected async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    return await runEmbeddingOperationWithTimeout({ timeoutMs, message, run: () => promise });
  }

  protected getIndexConcurrency(): number {
    if (this.batch.enabled) {
      return this.batch.concurrency;
    }
    const provider = this.syncProviderGeneration
      ? this.syncProviderGeneration.provider
      : this.provider;
    return provider?.id === "local" || provider?.id === "ollama" ? 1 : EMBEDDING_INDEX_CONCURRENCY;
  }

  private sourceReplacement(
    {
      prepared: { entry, source, chunks, retained, removedIds },
      embeddings,
      vectorReady,
    }: MemoryPreparedPublication,
    generation: MemorySyncProviderGeneration | null,
  ): MemorySourceIndexReplacement {
    return {
      entry: { path: entry.path, hash: entry.hash, mtimeMs: entry.mtimeMs, size: entry.size },
      chunks,
      embeddings,
      model: generation?.provider?.model ?? "fts-only",
      now: Date.now(),
      vectorReady,
      retained,
      removedIds,
      ...(source === "sessions"
        ? {
            source,
            agentId: this.agentId,
            sessionId: expectDefined(entry.sessionId, "memory index session identity"),
          }
        : { source }),
    };
  }

  private async writeChunkGroup(
    items: MemoryPreparedPublication[],
    generation: MemorySyncProviderGeneration | null,
  ): Promise<void> {
    const database = this.database;
    const sourceDatabase = generation?.database ?? this.publishedDatabase;
    await withMemoryWorkspaceLock(this.workspaceDir, async () => {
      const assertCurrent = () => {
        this.memoryFiles?.assertCurrent();
        if (
          this.closed ||
          database.closed ||
          !database.isOpen ||
          this.database !== database ||
          sourceDatabase !== this.publishedDatabase ||
          sourceDatabase.closed ||
          !sourceDatabase.isOpen ||
          (generation && this.syncProviderGeneration !== generation)
        ) {
          throw new Error("Memory source owner changed before replacement");
        }
      };
      const activeItems = [...items];
      const replacements = activeItems.map((item) => this.sourceReplacement(item, generation));
      const prepare = async (): Promise<boolean> => {
        for (let index = activeItems.length - 1; index >= 0; index--) {
          const {
            prepared: { entry, source },
          } = activeItems[index]!;
          if (source !== "memory") {
            continue;
          }
          const current = await (this.memoryFiles?.inspectFile ?? buildFileEntry)(
            entry.absPath,
            this.workspaceDir,
            this.settings.multimodal,
          );
          if (current?.hash !== entry.hash) {
            this.dirty = true;
            log.debug("memory source changed while indexing; queued incremental retry", {
              path: entry.path,
            });
            // A changed file must not veto unrelated sources in the same transaction.
            activeItems.splice(index, 1);
            replacements.splice(index, 1);
          }
        }
        assertCurrent();
        return replacements.length > 0;
      };
      const published =
        replacements.length > 1 && memoryPublicationGroup(replacements)
          ? await database.replaceSource(replacements, assertCurrent, prepare)
          : await database.replaceSource(
              expectDefined(replacements[0], "memory source publication"),
              assertCurrent,
              prepare,
            );
      if (!published) {
        return;
      }
      for (const {
        prepared: { chunks },
        vectorReady,
      } of activeItems) {
        database.vectorDegradedWriteWarningShown = logMemoryVectorDegradedWrite({
          vectorEnabled: this.vector.enabled,
          vectorReady,
          chunkCount: chunks.length,
          warningShown: database.vectorDegradedWriteWarningShown,
          loadError: this.vector.loadError,
          warn: (message) => log.warn(message),
        });
      }
    }).catch((error: unknown) => {
      this.markFailedFullReindexRetry({
        memory: false,
        sessions: items.some((item) => item.prepared.source === "sessions"),
      });
      throw error;
    });
  }

  private async prepareIndexEntry(
    entry: MemoryIndexEntry,
    source: MemorySource,
    generation: MemorySyncProviderGeneration | null,
    retain = true,
  ): Promise<PreparedMemoryIndexEntry | null> {
    const kind = entry.kind;
    const suppliedContent = entry.content;
    const prepare = async (): Promise<PreparedMemoryIndexEntry | null> => {
      if (kind === "multimodal") {
        const multimodalChunk: Awaited<
          ReturnType<NonNullable<typeof this.memoryFiles>["buildMultimodalChunk"]>
        > = await (this.memoryFiles?.buildMultimodalChunk ?? buildMultimodalChunkForIndexing)(
          entry,
        );
        if (!multimodalChunk) {
          this.dirty = true;
          await this.deleteIndexedFile(entry.path, source);
          return null;
        }
        const pathClassification = await resolveMemoryPathClassification({
          absolutePath: entry.absPath,
          source,
          workspaceDir: this.workspaceDir,
          readSource: this.memoryFiles ? multimodalChunk : undefined,
        });
        const chunk: IndexedMemoryChunk = {
          ...multimodalChunk.chunk,
          importance: null,
          triggers: null,
          projectKey: null,
        };
        chunk.provenance = resolveChunkProvenance(
          entry,
          source,
          chunk,
          pathClassification.originClass,
        );
        return {
          entry,
          source,
          chunks: [chunk],
          structuredInputBytes: multimodalChunk.structuredInputBytes,
        };
      }

      const read = await readMemoryIndexSource({
        absolutePath: entry.absPath,
        workspaceDir: this.workspaceDir,
        source,
        suppliedContent,
        memoryFiles: this.memoryFiles,
      });
      if (!read) {
        this.dirty = true;
        return null;
      }
      const cutoff = readSessionResetRecallCutoffMetadata(entry);
      const prepared = await prepareMemoryIndexInWorker({
        entry: {
          path: entry.path,
          mtimeMs: entry.mtimeMs,
          lineMap: entry.lineMap,
          lineProvenance: entry.lineProvenance,
        },
        source,
        content: read.content,
        pathClassification: read.pathClassification,
        chunking: this.settings.chunking,
        cutoffLine: cutoff.state === "valid" ? cutoff.cutoffLine : undefined,
        provider:
          generation?.kind === "semantic"
            ? { id: generation.provider.id, maxInputTokens: generation.provider.maxInputTokens }
            : undefined,
        hardMaxInputTokens: EMBEDDING_BATCH_MAX_TOKENS,
      });
      return {
        entry:
          prepared.contentHash !== undefined ? { ...entry, hash: prepared.contentHash } : entry,
        source,
        chunks: prepared.chunks,
      };
    };
    const preparedEntry =
      source === "sessions" && kind !== "multimodal" && typeof suppliedContent === "string"
        ? await withMemoryWorkspacePreparation(this.workspaceDir, prepare)
        : await withMemoryWorkspaceLock(this.workspaceDir, prepare);
    if (!preparedEntry || !retain) {
      return preparedEntry;
    }
    const database = this.database;
    return await retainIndexedSessionChunks(preparedEntry, database, generation, () => {
      if (this.closed || database.closed || this.database !== database) {
        throw new Error("Memory source owner changed before delta planning");
      }
    });
  }

  protected override async indexFiles(
    items: MemoryIndexWorkItem[],
  ): Promise<MemoryIndexWorkItem[]> {
    if (items.length === 0) {
      return [];
    }
    this.beginSyncProviderGeneration();
    try {
      return await this.indexFilesWithGeneration(items, this.syncProviderGeneration);
    } finally {
      this.endSyncProviderGeneration();
    }
  }

  private async indexFilesWithGeneration(
    items: MemoryIndexWorkItem[],
    generation: MemorySyncProviderGeneration | null,
  ): Promise<MemoryIndexWorkItem[]> {
    const prepared: Array<{ work: MemoryIndexWorkItem; value: PreparedMemoryIndexEntry }> = [];
    let preparedRequestCount = 0;
    let next = 0;
    while (next < items.length && prepared.length < SOURCE_WIDE_BATCH_MAX_FILES) {
      if (this.shouldYieldSessionIndexing()) {
        return [...prepared.map((item) => item.work), ...items.slice(next)];
      }
      const work = items[next++]!;
      // Multimodal rejection has a source-specific recovery path.
      if (work.entry.kind === "multimodal") {
        await this.indexFileWithGeneration(work.entry, work.source, generation);
        continue;
      }
      const value = await this.prepareIndexEntry(work.entry, work.source, generation);
      if (value) {
        prepared.push({ work, value });
        preparedRequestCount += value.chunks.length;
        if (preparedRequestCount >= SOURCE_WIDE_BATCH_MAX_REQUESTS) {
          break;
        }
      }
    }
    if (this.shouldYieldSessionIndexing()) {
      return [...prepared.map((item) => item.work), ...items.slice(next)];
    }
    const candidates = prepared.flatMap(({ value }) =>
      value.chunks.map((chunk) => ({ chunk, entry: value.entry, source: value.source })),
    );
    let embeddings: number[][] = [];
    if (generation?.kind === "semantic" && candidates.length > 0) {
      const cached = await this.collectCachedEmbeddings(candidates, generation);
      if (!this.batch.enabled) {
        embeddings = await this.embedChunksInBatches(
          candidates,
          generation,
          EMBEDDING_BATCH_MAX_TOKENS,
          cached,
        );
      } else {
        const sourceWide = generation.runtime?.sourceWideBatchEmbed === true;
        const requestSizes = sourceWide
          ? Array.from(
              { length: Math.ceil(candidates.length / SOURCE_WIDE_BATCH_MAX_REQUESTS) },
              (_, index) =>
                Math.min(
                  SOURCE_WIDE_BATCH_MAX_REQUESTS,
                  candidates.length - index * SOURCE_WIDE_BATCH_MAX_REQUESTS,
                ),
            )
          : prepared.map((item) => item.value.chunks.length);
        const resolved = new Map(
          candidates.flatMap((candidate, index) =>
            cached.embeddings[index]?.length
              ? [[candidate.chunk.hash, cached.embeddings[index]!] as const]
              : [],
          ),
        );
        let offset = 0;
        const requests = requestSizes.map((size) => {
          const batchCandidates = candidates.slice(offset, offset + size);
          offset += size;
          return async () => {
            const known = batchCandidates.map(
              (candidate) => resolved.get(candidate.chunk.hash) ?? [],
            );
            const missing = known.flatMap((embedding, index) =>
              embedding.length > 0 ? [] : [index],
            );
            const batchEmbeddings = await this.embedChunksWithBatch(
              batchCandidates,
              batchCandidates[0]?.source ?? "unknown",
              generation,
              {},
              {
                embeddings: known,
                missing,
                missingCandidates: missing.map((index) => batchCandidates[index]!),
              },
            );
            for (const [index, candidate] of batchCandidates.entries()) {
              const embedding = batchEmbeddings[index];
              if (embedding?.length) {
                resolved.set(candidate.chunk.hash, embedding);
              }
            }
            return batchEmbeddings;
          };
        });
        embeddings = (
          await runWithConcurrency(requests, sourceWide ? 1 : this.getIndexConcurrency())
        ).flat();
      }
    }
    const sample = embeddings.find((embedding) => embedding.length > 0);
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    let offset = 0;
    let cursor = 0;
    while (cursor < prepared.length) {
      if (this.shouldYieldSessionIndexing()) {
        return [...prepared.slice(cursor).map((item) => item.work), ...items.slice(next)];
      }
      const group: MemoryPreparedPublication[] = [];
      const groupStart = offset;
      let rows = 0;
      while (cursor < prepared.length && group.length < SOURCE_PUBLICATION_MAX_FILES) {
        const item = prepared[cursor]!.value;
        const rowCount =
          item.chunks.length + (item.retained?.length ?? 0) + (item.removedIds?.length ?? 0);
        const publication = {
          prepared: item,
          embeddings: embeddings.slice(offset, offset + item.chunks.length),
          vectorReady,
        };
        if (
          group.length > 0 &&
          (group[0]!.prepared.source !== item.source ||
            rows + rowCount > SOURCE_PUBLICATION_MAX_ROWS ||
            !memoryPublicationGroup(
              [...group, publication].map((source) => this.sourceReplacement(source, generation)),
            ))
        ) {
          break;
        }
        group.push(publication);
        rows += rowCount;
        offset += item.chunks.length;
        cursor++;
      }
      await this.writeChunkGroup(group, generation);
      // Publication has settled; later groups must not retain completed vectors.
      // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- Completed slots are never read or mutated.
      embeddings.fill([], groupStart, offset);
      for (const item of group) {
        item.embeddings = [];
      }
    }
    return next < items.length
      ? await this.indexFilesWithGeneration(items.slice(next), generation)
      : [];
  }

  protected async indexFile(entry: MemoryIndexEntry, source: MemorySource): Promise<void> {
    this.beginSyncProviderGeneration();
    try {
      await this.indexFileWithGeneration(entry, source, this.syncProviderGeneration);
    } finally {
      this.endSyncProviderGeneration();
    }
  }

  private async indexFileWithGeneration(
    entry: MemoryIndexEntry,
    source: MemorySource,
    generation: MemorySyncProviderGeneration | null,
    retain = true,
  ): Promise<void> {
    // Multimodal files require an embedding provider; skip in FTS-only mode.
    if (generation?.kind !== "semantic" && entry.kind === "multimodal") {
      return;
    }
    const prepared = await this.prepareIndexEntry(entry, source, generation, retain);
    if (!prepared) {
      return;
    }
    // An unchanged or truncated session has nothing to embed.
    if (generation?.kind !== "semantic" || prepared.chunks.length === 0) {
      return await this.writeChunkGroup(
        [{ prepared, embeddings: [], vectorReady: false }],
        generation,
      );
    }

    let embeddings: number[][];
    try {
      const candidates = prepared.chunks.map((chunk) => ({
        chunk,
        entry: prepared.entry,
        source: prepared.source,
      }));
      embeddings = await this.embedChunksWithBatch(candidates, source, generation);
    } catch (err) {
      const message = formatErrorMessage(err);
      if (
        entry.kind === "multimodal" &&
        /(413|payload too large|request too large|input too large|too many tokens|input limit|request size)/i.test(
          message,
        )
      ) {
        log.warn("memory embeddings: skipping multimodal file rejected as too large", {
          path: entry.path,
          bytes: prepared.structuredInputBytes,
          provider: generation.provider.id,
          model: generation.provider.model,
          error: message,
        });
        return await this.writeChunkGroup(
          [{ prepared: { ...prepared, chunks: [] }, embeddings: [], vectorReady: false }],
          generation,
        );
      }
      throw err;
    }
    const sample = embeddings.find((embedding) => embedding.length > 0);
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    await this.writeChunkGroup([{ prepared, embeddings, vectorReady }], generation);
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
