import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveEmbeddingInputFormatVersion } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  resolveAgentDir,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { SessionTranscriptCorpusEntry } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  formatMemoryIndexRebuildGuidance,
  MEMORY_CHUNKING_VERSION,
  MEMORY_INDEX_VECTOR_TABLE,
  type MemorySyncParams,
  type MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { withMemoryWorkspaceLock } from "../memory-workspace-lock.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderRuntime,
} from "./embeddings.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { memoryDatabaseTableExists } from "./manager-db-kernel.js";
import { cleanupAgedMemoryReindexTempFiles, removeMemoryDatabaseFiles } from "./manager-db.js";
import { isMemoryEmbeddingOperationError } from "./manager-embedding-errors.js";
import { withMemoryIndexGeneration } from "./manager-index-generation-lease.js";
import {
  resolveMemoryProviderLifecycle,
  resolveFallbackCurrentProviderId,
  resolveMemoryFallbackProviderRequest,
  resolveMemoryPrimaryProviderRequest,
} from "./manager-provider-state.js";
import type { MemoryManagerProviderFactory } from "./manager-registry.js";
import {
  MEMORY_INDEX_PROVENANCE_VERSION,
  resolveConfiguredScopeHash,
  resolveConfiguredSourcesForMeta,
  resolveMemoryIndexIdentityState,
  type MemoryIndexMeta,
  type MemoryIndexProviderIdentity,
} from "./manager-reindex-state.js";
import { MEMORY_INDEX_META_KEY } from "./manager-retrieval-read.js";
import { readMemoryShadowIdentity } from "./manager-shadow-task.js";
import { MemoryManagerSourceSyncOps } from "./manager-source-sync-ops.js";
import type { MemoryEmbeddingBatchConfig, MemorySyncProgressState } from "./manager-sync-base.js";
import { hasTargetedSessionSyncParams } from "./manager-sync-control.js";
import { MEMORY_SYNC_DEFERRED, type MemorySyncOutcome } from "./manager-sync-outcome.js";

export type { MemoryIndexWorkItem } from "./manager-sync-base.js";

type MemorySyncProviderGenerationBase = {
  database: MemoryIndexDatabase;
  databaseRevision: number;
  cacheWritesInvalidated: boolean;
  providerKey: string;
  identities: MemoryIndexProviderIdentity[];
};

export type MemorySyncProviderGeneration =
  | (MemorySyncProviderGenerationBase & { kind: "fts-only"; provider: null })
  | (MemorySyncProviderGenerationBase & {
      kind: "semantic";
      embeddingDimensions?: number;
      provider: EmbeddingProvider;
      runtime?: EmbeddingProviderRuntime;
    });

export type MemorySemanticProviderGeneration = Extract<
  MemorySyncProviderGeneration,
  { kind: "semantic" }
>;

const log = createSubsystemLogger("memory");

export abstract class MemoryManagerSyncOps extends MemoryManagerSourceSyncOps {
  protected readonly automaticRebuildNotice: { sequence: number; warning: string };

  protected constructor(notice?: { sequence: number; warning: string }) {
    super();
    this.automaticRebuildNotice = notice ?? { sequence: 0, warning: "" };
  }

  protected recordAutomaticRebuild(): void {
    this.automaticRebuildNotice.sequence += 1;
    this.automaticRebuildNotice.warning = `Automatic memory index repair was requested. To rebuild manually, run: ${formatMemoryIndexRebuildGuidance({ requestedProvider: this.settings.provider }, this.agentId)}`;
  }

  protected takeSearchMaintenanceRequest() {
    const generation = this.takeReindexRetryStateForMaintenance();
    // The request must be visible before detached acquisition or embedding finishes.
    if (generation.memoryFullRetryDirty || generation.sessionsFullRetryDirty) {
      this.recordAutomaticRebuild();
    }
    return generation;
  }

  protected abstract readonly createProvider: MemoryManagerProviderFactory;
  protected fallbackProviderInitPromise: Promise<boolean> | null = null;
  protected syncProviderGeneration: MemorySyncProviderGeneration | null = null;

  protected abstract beginSyncProviderGeneration(options?: { forceFtsOnly?: boolean }): void;
  protected abstract endSyncProviderGeneration(): void;

  protected override shouldDeferSourceWideBatch(): boolean {
    const generation = this.syncProviderGeneration;
    const provider = generation ? generation.provider : this.provider;
    const providerRuntime = generation
      ? generation.kind === "semantic"
        ? generation.runtime
        : undefined
      : this.providerRuntime;
    return Boolean(
      this.batch.enabled &&
      provider &&
      providerRuntime?.batchEmbed &&
      providerRuntime.sourceWideBatchEmbed === true,
    );
  }

  protected abstract retireCurrentProvider(): Promise<void>;

  protected createConfiguredEmbeddingProvider(
    request = resolveMemoryPrimaryProviderRequest({ settings: this.settings }),
  ) {
    return createEmbeddingProvider({
      createProvider: this.createProvider,
      config: this.cfg,
      agentDir: resolveAgentDir(this.cfg, this.agentId),
      ...(this.acquireLocalService ? { acquireLocalService: this.acquireLocalService } : {}),
      ...request,
    });
  }

  private createSyncProgress(
    onProgress: (update: MemorySyncProgressUpdate) => void,
  ): MemorySyncProgressState {
    const state: MemorySyncProgressState = {
      completed: 0,
      total: 0,
      label: undefined,
      report: (update) => {
        if (update.label) {
          state.label = update.label;
        }
        const label =
          update.total > 0 && state.label
            ? `${state.label} ${update.completed}/${update.total}`
            : state.label;
        onProgress({
          completed: update.completed,
          total: update.total,
          label,
        });
      },
    };
    return state;
  }

  private assertFtsOnlySyncAllowed(): void {
    const provider = this.syncProviderGeneration
      ? this.syncProviderGeneration.provider
      : this.provider;
    if (provider) {
      return;
    }
    this.assertRequiredProviderAvailable("sync");
    const existingMeta = this.readMeta();
    if (
      !existingMeta ||
      existingMeta.model === "fts-only" ||
      !this.settings.provider ||
      this.settings.provider === "none"
    ) {
      return;
    }
    const providerFailure = this.providerUnavailableReason;
    this.resetProviderInitializationForRetry();
    throw new Error(
      `Memory sync aborted: embedding provider "${this.settings.provider}" is configured but unavailable. ` +
        `Refusing to run sync in fts-only fallback mode to protect existing vector index (current model: ${existingMeta.model}).` +
        (providerFailure ? ` Provider failure: ${providerFailure}` : ""),
    );
  }

  protected async runSync(params?: MemorySyncParams): Promise<MemorySyncOutcome> {
    const hasTargetSessionRequest = hasTargetedSessionSyncParams(params);
    let needsFullReindex = Boolean(params?.force && !hasTargetSessionRequest);
    try {
      // An unavailable configured provider must not replace semantic vectors
      // with FTS-only rows; fresh and already-FTS-only indexes remain safe.
      this.assertFtsOnlySyncAllowed();

      const syncProvider = this.syncProviderGeneration
        ? this.syncProviderGeneration.provider
        : this.provider;

      const progress = params?.progress ? this.createSyncProgress(params.progress) : undefined;
      if (progress) {
        progress.report({
          completed: progress.completed,
          total: progress.total,
          label: "Loading vector extension…",
        });
      }
      // Keyword-only generations never write vectors, so they must not wait for
      // the vector extension before text and FTS indexing can proceed.
      const vectorReady = syncProvider ? await this.ensureVectorReady() : false;
      const meta = this.readMeta();
      // A sibling manager can publish different dimensions or an empty rebuild.
      if (this.database.ensuredVectorDimensions !== meta?.vectorDims) {
        this.database.ensuredVectorDimensions = undefined;
      }
      // Resolve and index a targeted session against one corpus snapshot. A reset
      // between separate enumerations could otherwise replace the chosen identity.
      const targetSessionSync = hasTargetSessionRequest
        ? await this.resolveTargetSessionSyncPlan({
            sessions: params?.sessions,
            archiveFiles: params?.archiveFiles,
          })
        : null;
      const targetArchiveFiles = targetSessionSync?.targetArchiveFiles ?? null;
      const hasTargetArchiveFiles = targetArchiveFiles !== null;
      if (hasTargetSessionRequest && !hasTargetArchiveFiles) {
        return;
      }
      if (params?.reason === "cli" && !params.force && !hasTargetArchiveFiles) {
        await this.markSessionStartupCatchupDirtyFiles();
      }
      const syncProviderKey = this.syncProviderGeneration
        ? this.syncProviderGeneration.providerKey
        : this.providerKey;
      const syncProviderIdentities =
        this.syncProviderGeneration?.identities ?? this.resolveProviderIndexIdentities();
      const hasIndexedChunks = this.hasIndexedChunks();
      const indexIdentity = resolveMemoryIndexIdentityState({
        meta,
        // Also detects provider→FTS-only transitions so orphaned old-model FTS rows are cleaned up.
        provider: syncProvider ? { id: syncProvider.id, model: syncProvider.model } : null,
        providerKey: syncProviderKey ?? undefined,
        providerAliases: syncProviderIdentities.slice(1),
        configuredSources: resolveConfiguredSourcesForMeta(this.sources),
        configuredScopeHash: resolveConfiguredScopeHash({
          workspaceDir: this.workspaceDir,
          extraPaths: this.settings.extraPaths,
          multimodal: this.settings.multimodal,
        }),
        chunkTokens: this.settings.chunking.tokens,
        chunkOverlap: this.settings.chunking.overlap,
        vectorReady,
        hasIndexedChunks,
        ftsTokenizer: this.settings.store.fts.tokenizer,
      });
      if (
        indexIdentity.status === "mismatched" &&
        indexIdentity.owner === "openclaw" &&
        indexIdentity.versionOrder === "newer" &&
        params?.reason !== "cli"
      ) {
        // Keep automatic force/retry/bootstrap paths from overwriting a newer publication.
        needsFullReindex = true;
        return;
      }
      const needsInitialIndex = indexIdentity.status !== "valid" && !hasIndexedChunks;
      // Missing metadata cannot prove whether existing chunks were semantic.
      // Wait for the configured provider before replacing them with a rebuilt index,
      // unless every existing chunk is FTS-only — in that case rebuilding as
      // FTS-only is safe even without a provider because no semantic data is lost.
      // Gate the chunk-model scan: only compute when identity is missing,
      // chunks exist, and the provider is unavailable (no target session files
      // is already checked by needsMissingIdentityReindex below).
      const needsFtsOnlyClassification =
        indexIdentity.status === "missing" &&
        hasIndexedChunks &&
        syncProvider === null &&
        Boolean(this.settings.provider) &&
        this.settings.provider !== "none";
      const hasOnlyFtsChunks = needsFtsOnlyClassification && !this.hasSemanticChunks();
      const canRebuildMissingIdentity =
        syncProvider !== null ||
        !this.settings.provider ||
        this.settings.provider === "none" ||
        hasOnlyFtsChunks;
      const needsMissingIdentityReindex =
        indexIdentity.status === "missing" && !hasTargetArchiveFiles && canRebuildMissingIdentity;
      const needsExplicitIdentityReindex =
        params?.reason === "cli" && indexIdentity.status !== "valid" && !hasTargetArchiveFiles;
      // Runtime format changes need a shadow rebuild even when source hashes match.
      const needsRuntimeVersionReindex =
        indexIdentity.status === "mismatched" &&
        indexIdentity.owner === "openclaw" &&
        !hasTargetArchiveFiles;
      const canRunRetryFullReindex =
        indexIdentity.status !== "missing" || needsInitialIndex || canRebuildMissingIdentity;
      const retryFullReindexRequested = this.memoryFullRetryDirty || this.sessionsFullRetryDirty;
      const fullRetryRemainsAfterTargetSync = hasTargetArchiveFiles && retryFullReindexRequested;
      const retryFullReindexBackedOff =
        retryFullReindexRequested &&
        (!params?.force || params.reason === "embedding-bootstrap-recovery") &&
        // A semantic failure must still allow the distinct keyword-only publication.
        !(this.fullReindexRetryBackoff.failedWithEmbeddings && !syncProvider) &&
        Date.now() < this.fullReindexRetryBackoff.retryAt;
      const deferAutomaticFullReindex = retryFullReindexBackedOff && !needsExplicitIdentityReindex;
      if (deferAutomaticFullReindex && !hasTargetArchiveFiles) {
        // Automatic identity repair honors the failure cooldown. An explicit
        // CLI index request still retries immediately.
        return MEMORY_SYNC_DEFERRED;
      }
      needsFullReindex =
        (params?.force && !hasTargetArchiveFiles) ||
        needsExplicitIdentityReindex ||
        (!deferAutomaticFullReindex &&
          (needsInitialIndex || needsMissingIdentityReindex || needsRuntimeVersionReindex)) ||
        (!hasTargetArchiveFiles &&
          !deferAutomaticFullReindex &&
          ((this.memoryFullRetryDirty && canRunRetryFullReindex) ||
            (this.sessionsFullRetryDirty &&
              indexIdentity.status !== "valid" &&
              canRunRetryFullReindex)));
      // Empty indexes still need source discovery when no watcher or session listener runs.
      const isSearchBootstrap = params?.reason === "search-bootstrap";
      const needsFullSessionReindex =
        needsFullReindex ||
        (this.sessionsFullRetryDirty && !hasTargetArchiveFiles && !deferAutomaticFullReindex) ||
        isSearchBootstrap;
      if (indexIdentity.status !== "valid" && !needsFullReindex) {
        this.dirty = true;
        const sessionsDirty = this.markTargetArchiveFilesDirty(targetArchiveFiles);
        if (sessionsDirty) {
          this.sessionsDirty = true;
        }
        return fullRetryRemainsAfterTargetSync ? MEMORY_SYNC_DEFERRED : undefined;
      }
      if (!needsFullSessionReindex) {
        if (this.sources.has("sessions") && targetArchiveFiles) {
          this.sessionsDirty = this.markTargetArchiveFilesDirty(targetArchiveFiles);
        }
        if (
          await this.syncTargetedSessions(
            targetArchiveFiles,
            targetSessionSync?.corpusEntries,
            progress,
          )
        ) {
          return fullRetryRemainsAfterTargetSync ? MEMORY_SYNC_DEFERRED : undefined;
        }
      }
      let recoveringSessionFullRetry = false;
      try {
        if (needsFullReindex) {
          if (params?.reason !== "cli") {
            this.recordAutomaticRebuild();
          }
          await this.runInPlaceReindex(progress);
          return;
        }

        // Explicit indexing must discover changes without a running watcher.
        const shouldSyncMemory =
          this.sources.has("memory") &&
          (params?.reason === "cli" || this.dirty || isSearchBootstrap);
        const shouldSyncSessions = this.shouldSyncSessions(params, needsFullSessionReindex);
        recoveringSessionFullRetry = this.sessionsFullRetryDirty && shouldSyncSessions;

        await this.executeSourceSync({
          shouldSyncMemory,
          shouldSyncSessions,
          needsFullReindex,
          needsFullSessionReindex,
          targetArchiveFiles: targetArchiveFiles ? Array.from(targetArchiveFiles) : undefined,
          progress: progress ?? undefined,
        });
        if (recoveringSessionFullRetry && !this.memoryFullRetryDirty) {
          this.clearFullReindexRetryBackoff();
        }
      } catch (err) {
        this.dirty ||= this.sources.has("memory");
        if (recoveringSessionFullRetry && !this.memoryFullRetryDirty) {
          this.markFailedFullReindexRetry({ memory: false, sessions: true });
          this.recordFullReindexFailure(syncProvider !== null);
        }
        const reason = formatErrorMessage(err);
        const shouldFallback = isMemoryEmbeddingOperationError(err);
        if (shouldFallback) {
          // A failed generation cannot wait on its own sync lease while activating fallback.
          this.endSyncProviderGeneration();
        }
        const activated = shouldFallback && (await this.activateFallbackProvider(reason));
        if (activated) {
          if ((needsFullReindex || isSearchBootstrap) && !hasTargetArchiveFiles) {
            needsFullReindex = true;
            this.beginSyncProviderGeneration();
            await this.runInPlaceReindex(progress);
          }
          return;
        }
        if (!this.provider && this.fts.enabled && isMemoryEmbeddingOperationError(err)) {
          this.syncOutcomes.recordActiveFailure(err);
          log.warn(`memory embeddings unavailable; leaving memory index dirty: ${reason}`);
          return;
        }
        throw err;
      }
    } finally {
      // Ordinary sync exits retain live cleanup, including preflight/no-op exits.
      // Full rebuild failures (including forced preflight) leave the primary alone.
      if (!needsFullReindex) {
        await this.pruneEmbeddingCacheIfNeeded();
      }
    }
  }

  protected markTargetArchiveFilesDirty(targetArchiveFiles?: Iterable<string> | null): boolean {
    for (const file of targetArchiveFiles ?? []) {
      this.sessionsDirtyFiles.add(file);
    }
    return this.sessionsDirtyFiles.size > 0;
  }

  protected async syncTargetedSessions(
    targetArchiveFiles: Set<string> | null,
    corpusEntries?: readonly SessionTranscriptCorpusEntry[],
    progress?: MemorySyncProgressState,
  ): Promise<boolean> {
    if (!this.sources.has("sessions") || !targetArchiveFiles) {
      return false;
    }
    const { sessionsDirtyFiles, sessionsFullRetryDirty, sessionsReconcileDirty } = this;
    let failure: { error: unknown } | undefined;
    try {
      await this.syncArchiveFiles({
        needsFullReindex: false,
        targetArchiveFiles: Array.from(targetArchiveFiles),
        progress,
        corpusEntries,
      });
      for (const file of targetArchiveFiles) {
        sessionsDirtyFiles.delete(file);
      }
    } catch (error) {
      const reason = formatErrorMessage(error);
      const shouldFallback = isMemoryEmbeddingOperationError(error);
      if (shouldFallback) {
        this.endSyncProviderGeneration();
      }
      if (!shouldFallback || !(await this.activateFallbackProvider(reason))) {
        throw error;
      }
      for (const file of targetArchiveFiles) {
        sessionsDirtyFiles.add(file);
      }
      failure = { error };
    }
    this.sessionsDirty =
      sessionsFullRetryDirty || sessionsReconcileDirty || sessionsDirtyFiles.size > 0;
    if (failure) {
      this.syncOutcomes.recordActiveFailure(failure.error);
    }
    return true;
  }

  protected resolveBatchConfig(): MemoryEmbeddingBatchConfig {
    const batch = this.settings.remote?.batch;
    const enabled = Boolean(batch?.enabled && this.provider && this.providerRuntime?.batchEmbed);
    return {
      enabled,
      wait: batch?.wait ?? true,
      concurrency: Math.max(1, batch?.concurrency ?? 2),
      pollIntervalMs: batch?.pollIntervalMs ?? 2000,
      timeoutMs: resolveTimerTimeoutMs((batch?.timeoutMinutes ?? 60) * 60 * 1000, 60 * 60_000),
    };
  }

  protected async activateFallbackProvider(reason: string): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    const pending = this.fallbackProviderInitPromise;
    if (pending) {
      return await pending;
    }
    const activation = this.activateFallbackProviderOnce(reason);
    this.fallbackProviderInitPromise = activation;
    try {
      return await activation;
    } finally {
      if (this.fallbackProviderInitPromise === activation) {
        this.fallbackProviderInitPromise = null;
      }
    }
  }

  private async activateFallbackProviderOnce(reason: string): Promise<boolean> {
    const currentProviderId = resolveFallbackCurrentProviderId({
      provider: this.provider,
      lifecycle: this.providerLifecycle,
    });
    const fallbackRequest = resolveMemoryFallbackProviderRequest({
      cfg: this.cfg,
      settings: this.settings,
      currentProviderId,
    });
    if (!fallbackRequest || !currentProviderId) {
      return false;
    }
    if (this.fallbackFrom) {
      return false;
    }

    this.providerLifecycle = {
      mode: "degraded",
      providerId: currentProviderId,
      reason,
    };
    await this.retireCurrentProvider();
    if (this.closed) {
      return false;
    }

    let fallbackResult;
    try {
      fallbackResult = await this.createConfiguredEmbeddingProvider(fallbackRequest);
    } catch (err) {
      // Retirement already removed the primary before fallback construction.
      // Make the configured provider retryable instead of stranding FTS-only mode.
      this.resetProviderInitializationForRetry();
      throw err;
    }
    if (!fallbackResult.provider) {
      this.resetProviderInitializationForRetry();
      return false;
    }

    this.providerLifecycle = resolveMemoryProviderLifecycle({
      provider: fallbackResult.provider,
      runtime: fallbackResult.runtime,
      requestedProvider: currentProviderId,
      fallbackFrom: currentProviderId,
      fallbackReason: reason,
    });
    this.fallbackFrom = currentProviderId;
    this.fallbackReason = reason;
    this.provider = fallbackResult.provider;
    this.providerRuntime = fallbackResult.runtime;
    this.providerUnavailableReason = undefined;
    this.providerKey = this.computeProviderKey();
    this.batch = this.resolveBatchConfig();
    log.warn(`memory embeddings: switched to fallback provider (${fallbackRequest.provider})`, {
      reason,
    });
    return true;
  }

  private async runInPlaceReindex(progress?: MemorySyncProgressState): Promise<void> {
    // Build outside the shared agent DB, then publish only memory-owned tables
    // in one short transaction so failed rebuilds leave the current index usable.
    const dbPath = resolveUserPath(this.settings.store.databasePath);
    const tempDbPath = `${dbPath}.memory-reindex-${randomUUID()}`;
    const originalDb = this.db;
    const originalRetryState = this.snapshotReindexRetryState();
    const withEmbeddings = this.syncProviderGeneration?.kind === "semantic";
    const shouldRetryMemoryOnFailure = this.sources.has("memory");
    const shouldRetrySessionsOnFailure = this.shouldSyncSessions(undefined, true);
    let shadowCleanup: MemoryIndexDatabase | undefined;
    try {
      await cleanupAgedMemoryReindexTempFiles(dbPath);
      const originalRevision = this.database.facts.revision;
      const shadow = await MemoryIndexDatabase.openShadow(
        tempDbPath,
        this.settings.store.vector.enabled,
      );
      shadowCleanup = shadow;
      shadow.vector.enabled = this.vector.enabled;
      shadow.vector.extensionPath = this.vector.extensionPath;
      shadow.fts.enabled = this.fts.enabled;
      // Only the awaited rebuild inherits the shadow. Concurrent searches and
      // status keep the published handle and its vector/FTS/metadata state.
      const rebuilt = await this.withReindexDatabase(shadow, async () => {
        try {
          await shadow.admitSchema({
            cacheEnabled: this.cache.enabled,
            ftsEnabled: shadow.fts.enabled,
            ftsTokenizer: this.settings.store.fts.tokenizer,
          });

          await this.executeSourceSync({
            shouldSyncMemory: shouldRetryMemoryOnFailure,
            shouldSyncSessions: shouldRetrySessionsOnFailure,
            needsFullReindex: true,
            progress,
          });
          if (!shouldRetryMemoryOnFailure) {
            this.clearMemoryRetryState();
          }
          const syncProvider = this.syncProviderGeneration
            ? this.syncProviderGeneration.provider
            : this.provider;
          const vectorIndexComplete = syncProvider === null || this.vector.available === true;
          const nextMeta: MemoryIndexMeta = {
            model: syncProvider?.model ?? "fts-only",
            provider: syncProvider?.id ?? "none",
            providerKey: this.syncProviderGeneration
              ? this.syncProviderGeneration.providerKey
              : this.providerKey!,
            sources: resolveConfiguredSourcesForMeta(this.sources),
            scopeHash: resolveConfiguredScopeHash({
              workspaceDir: this.workspaceDir,
              extraPaths: this.settings.extraPaths,
              multimodal: this.settings.multimodal,
            }),
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

          await this.writeMeta(nextMeta);
          return {
            nextMeta,
            vectorIndexComplete,
            hasVectors: memoryDatabaseTableExists(shadow.db, "main", MEMORY_INDEX_VECTOR_TABLE),
          };
        } finally {
          // Escaped continuations must fail closed, never write to the live DB.
          shadow.closed = true;
        }
      });

      await withMemoryWorkspaceLock(this.workspaceDir, async () => {
        await withMemoryIndexGeneration(dbPath, "write", async () => {
          await this.publishedDatabase.publishShadow(
            {
              sourcePath: tempDbPath,
              sourceIdentity: readMemoryShadowIdentity(tempDbPath),
              metaKey: MEMORY_INDEX_META_KEY,
              expectedRevision: originalRevision,
              sourceHasVectors: rebuilt.hasVectors,
              vectorIndexComplete: rebuilt.vectorIndexComplete,
              extensionPath: shadow.vector.extensionPath,
            },
            () => {
              if (
                this.closed ||
                this.publishedDatabase.closed ||
                this.publishedDatabase.readOnly ||
                this.publishedDatabase.db !== originalDb ||
                !originalDb.isOpen
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
      this.recordFullReindexFailure(withEmbeddings);
      throw err;
    } finally {
      try {
        if (shadowCleanup?.shadowReleased) {
          shadowCleanup.assertShadowPath();
          await removeMemoryDatabaseFiles(tempDbPath);
        }
      } catch (err) {
        log.warn(`failed to remove memory reindex shadow database: ${formatErrorMessage(err)}`);
      }
    }
  }
}
