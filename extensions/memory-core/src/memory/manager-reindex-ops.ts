import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveEmbeddingInputFormatVersion } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  MEMORY_CHUNKING_VERSION,
  type MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { withMemoryWorkspaceLock } from "../memory-workspace-lock.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { cleanupAgedMemoryReindexTempFiles, removeMemoryDatabaseFiles } from "./manager-db.js";
import { withMemoryIndexGeneration } from "./manager-index-generation-lease.js";
import {
  publishPostgresMemoryStage,
  withPostgresMemoryReindex,
} from "./manager-postgres-reindex.js";
import {
  MEMORY_INDEX_PROVENANCE_VERSION,
  resolveConfiguredSourcesForMeta,
  type MemoryIndexMeta,
} from "./manager-reindex-state.js";
import { MEMORY_INDEX_META_KEY } from "./manager-retrieval-read.js";
import { readMemoryShadowIdentity } from "./manager-shadow-task.js";
import { MemoryManagerSourceSyncOps } from "./manager-source-sync-ops.js";
import type {
  MemoryReindexProgress,
  MemoryReindexRetryState,
  MemorySyncProgressState,
} from "./manager-sync-base.js";
import {
  MemoryBackgroundRebuildInterruptedError,
  hasTargetedSessionSyncParams,
  memorySessionSyncTargetKey,
} from "./manager-sync-control.js";

const log = createSubsystemLogger("memory");

export abstract class MemoryManagerReindexOps extends MemoryManagerSourceSyncOps {
  private reindexState?: {
    shadow: MemoryIndexDatabase;
    tempDbPath: string;
    originalDatabase: MemoryIndexDatabase;
    originalRevision: number;
    originalRetryState: MemoryReindexRetryState;
    providerKey: string | null;
    publishedIdentity: string | null;
    progress: MemoryReindexProgress;
  };

  protected override get reindexProgress(): MemoryReindexProgress | undefined {
    return this.reindexState?.progress;
  }

  protected async discardReindex(): Promise<void> {
    const state = this.reindexState;
    if (!state) {
      return;
    }
    await state.shadow.closeShadow();
    this.reindexState = undefined;
    if (!state.shadow.postgresStageId) {
      state.shadow.assertShadowPath();
      await removeMemoryDatabaseFiles(state.tempDbPath);
    }
  }

  protected async resumeReindex(params?: MemorySyncParams): Promise<boolean> {
    if (this.reindexState) {
      const state = this.reindexState;
      if (
        state.shadow.closed ||
        state.providerKey !== (this.syncProviderGeneration?.providerKey ?? this.providerKey) ||
        state.publishedIdentity !== this.publishedDatabase.facts.serialized ||
        (params?.force && !hasTargetedSessionSyncParams(params))
      ) {
        this.adoptReindexRetryState(state.originalRetryState);
        this.markFailedFullReindexRetry({
          memory: this.sources.has("memory"),
          sessions: this.sources.has("sessions"),
        });
        await this.discardReindex();
      } else {
        for (const file of params?.archiveFiles ?? []) {
          state.progress.changedSessionFiles.add(file);
        }
        for (const target of params?.sessions ?? []) {
          state.progress.changedSessionTargets.set(memorySessionSyncTargetKey(target), target);
        }
        return true;
      }
    }
    return false;
  }

  protected async runInPlaceReindex(
    progress?: MemorySyncProgressState,
    postgresStage?: MemoryIndexDatabase,
  ): Promise<void> {
    if (this.publishedDatabase.admission?.engine === "postgres" && !postgresStage) {
      return withPostgresMemoryReindex(this.publishedDatabase, (stage) =>
        this.runInPlaceReindex(progress, stage),
      );
    }
    // Build outside the shared agent DB, then publish only memory-owned tables
    // in one short transaction so failed rebuilds leave the current index usable.
    const dbPath = resolveUserPath(this.settings.store.databasePath);
    const resuming = this.reindexState;
    const tempDbPath = resuming?.tempDbPath ?? `${dbPath}.memory-reindex-${randomUUID()}`;
    const originalDatabase = resuming?.originalDatabase ?? this.database;
    const originalRetryState = resuming?.originalRetryState ?? this.snapshotReindexRetryState();
    const withEmbeddings = this.syncProviderGeneration?.kind === "semantic";
    const shouldRetryMemoryOnFailure = this.sources.has("memory");
    const shouldRetrySessionsOnFailure = this.shouldSyncSessions(undefined, true);
    let suspended = false;
    try {
      if (!postgresStage && !resuming) {
        await cleanupAgedMemoryReindexTempFiles(dbPath);
      }
      const originalRevision = resuming?.originalRevision ?? this.database.facts.revision;
      const shadow =
        resuming?.shadow ??
        postgresStage ??
        (await MemoryIndexDatabase.openShadow(tempDbPath, this.settings.store.vector.enabled));
      const state = (this.reindexState ??= {
        shadow,
        tempDbPath,
        originalDatabase,
        originalRevision,
        originalRetryState,
        providerKey: this.syncProviderGeneration?.providerKey ?? this.providerKey,
        publishedIdentity: originalDatabase.facts.serialized,
        progress: {
          memoryComplete: false,
          completedSessionFiles: new Set(),
          changedSessionFiles: new Set(),
          changedSessionTargets: new Map(),
          yielded: false,
        },
      });
      state.progress.yielded = false;
      if (!resuming) {
        shadow.vector.enabled = this.vector.enabled;
        shadow.vector.extensionPath = this.vector.extensionPath;
        shadow.fts.enabled = this.fts.enabled;
      }
      // Only the awaited rebuild inherits the shadow. Concurrent searches and
      // status keep the published handle and its vector/FTS/metadata state.
      const rebuilt = await this.withReindexDatabase(shadow, async () => {
        if (!resuming) {
          await shadow.admitSchema({
            cacheEnabled: this.cache.enabled,
            ftsEnabled: shadow.fts.enabled,
            ftsTokenizer: this.settings.store.fts.tokenizer,
            fresh: postgresStage ? undefined : true,
          });
        }
        let memoryWatchGeneration: number;
        do {
          memoryWatchGeneration = this.memoryWatchGeneration;
          await this.executeSourceSync({
            shouldSyncMemory:
              shouldRetryMemoryOnFailure && (!state.progress.memoryComplete || this.dirty),
            shouldSyncSessions: shouldRetrySessionsOnFailure,
            // The private index is initially empty. On resume its own rows
            // preserve completed memory work, including a partial batch.
            needsFullReindex: false,
            needsFullSessionReindex: true,
            progress,
          });
          if (state.progress.yielded) {
            suspended = true;
            return undefined;
          }
        } while (
          shadow.supportsReindexSuspension &&
          (this.memoryWatchGeneration !== memoryWatchGeneration ||
            state.progress.changedSessionFiles.size ||
            state.progress.changedSessionTargets.size)
        );
        const syncProvider = this.syncProviderGeneration
          ? this.syncProviderGeneration.provider
          : this.provider;
        // Empty rebuilds have no missing vectors, even before the extension is needed.
        const vectorIndexComplete =
          syncProvider === null || !shadow.facts.hasIndexedChunks || this.vector.available === true;
        const nextMeta: MemoryIndexMeta = {
          model: syncProvider?.model ?? "fts-only",
          provider: syncProvider?.id ?? "none",
          providerKey: this.syncProviderGeneration
            ? this.syncProviderGeneration.providerKey
            : this.providerKey!,
          sources: resolveConfiguredSourcesForMeta(this.sources),
          scopeHash: this.resolveConfiguredMemoryScopeHash(),
          chunkTokens: this.settings.chunking.tokens,
          chunkOverlap: this.settings.chunking.overlap,
          chunkingVersion: MEMORY_CHUNKING_VERSION,
          embeddingInputFormatVersion: resolveEmbeddingInputFormatVersion(
            syncProvider?.model ?? "",
          ),
          ftsTokenizer: this.settings.store.fts.tokenizer,
          provenanceVersion: MEMORY_INDEX_PROVENANCE_VERSION,
        };
        if (this.vector.available && this.vector.dims) {
          nextMeta.vectorDims = this.vector.dims;
        }

        await this.database.writeMetadata(nextMeta);
        return {
          nextMeta,
          vectorIndexComplete,
        };
      });
      if (!rebuilt) {
        return;
      }
      // Publication attaches the finished file only after its writer closes.
      await shadow.closeShadow();

      await withMemoryWorkspaceLock(this.workspaceDir, async () => {
        await withMemoryIndexGeneration(dbPath, "write", async () => {
          if (postgresStage) {
            await publishPostgresMemoryStage(
              this.publishedDatabase,
              postgresStage,
              originalRevision,
              rebuilt.vectorIndexComplete,
              () => {
                if (
                  this.closed ||
                  this.publishedDatabase !== originalDatabase ||
                  !originalDatabase.isOpen
                ) {
                  throw new Error("Memory publication owner changed before reindex publication");
                }
              },
            );
            return;
          }
          await this.publishedDatabase.publishShadow(
            {
              sourcePath: tempDbPath,
              sourceIdentity: readMemoryShadowIdentity(tempDbPath),
              metaKey: MEMORY_INDEX_META_KEY,
              expectedRevision: originalRevision,
              sourceSchema: shadow.searchSchema,
              vectorIndexComplete: rebuilt.vectorIndexComplete,
              extensionPath: shadow.vector.extensionPath,
            },
            () => {
              if (
                this.closed ||
                this.publishedDatabase.closed ||
                this.publishedDatabase.readOnly ||
                this.publishedDatabase !== originalDatabase ||
                !originalDatabase.isOpen
              ) {
                throw new Error("Memory publication owner changed before reindex publication");
              }
              shadow.assertShadowPath();
            },
          );
        });
      });

      this.resetVectorState(rebuilt.vectorIndexComplete);
      this.fts.available = shadow.fts.available;
      this.fts.loadError = shadow.fts.loadError;
      this.vector.dims = rebuilt.nextMeta.vectorDims;
      // Cache-only rebuilds bypass insertion-time eviction; prune the canonical
      // cache only after successful publication so failed rebuilds retain their work.
      await this.pruneEmbeddingCacheIfNeeded();
      this.clearFullReindexRetryBackoff();
    } catch (err) {
      this.adoptReindexRetryState(originalRetryState);
      this.markFailedFullReindexRetry({
        memory: shouldRetryMemoryOnFailure,
        sessions: shouldRetrySessionsOnFailure,
      });
      if (!(err instanceof MemoryBackgroundRebuildInterruptedError)) {
        this.recordFullReindexFailure(withEmbeddings);
      }
      throw err;
    } finally {
      try {
        if (!suspended) {
          await this.discardReindex();
        }
      } catch (err) {
        log.warn(`failed to remove memory reindex shadow database: ${formatErrorMessage(err)}`);
      }
    }
  }
}
