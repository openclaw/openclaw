import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveAgentDir,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { SessionTranscriptCorpusEntry } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  formatMemoryIndexRebuildGuidance,
  type MemorySyncParams,
  type MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { resolveActiveMemoryRecallSources } from "./active-memory-session-sources.js";
import { createEmbeddingProvider, type EmbeddingProviderResult } from "./embeddings.js";
import { isMemoryEmbeddingOperationError } from "./manager-embedding-errors.js";
import {
  resolveMemoryProviderLifecycle,
  resolveFallbackCurrentProviderId,
  resolveMemoryFallbackProviderRequest,
  resolveMemoryPrimaryProviderRequest,
} from "./manager-provider-state.js";
import type { MemoryManagerProviderFactory } from "./manager-registry.js";
import { MemoryManagerReindexOps } from "./manager-reindex-ops.js";
import {
  canUpgradeMemoryIndexProviderKey,
  resolveConfiguredSourcesForMeta,
  resolveMemoryIndexIdentityState,
} from "./manager-reindex-state.js";
import type { MemoryEmbeddingBatchConfig, MemorySyncProgressState } from "./manager-sync-base.js";
import { hasTargetedSessionSyncParams } from "./manager-sync-control.js";
import { MEMORY_SYNC_DEFERRED, type MemorySyncOutcome } from "./manager-sync-outcome.js";

const log = createSubsystemLogger("memory");

export abstract class MemoryManagerSyncOps extends MemoryManagerReindexOps {
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
  protected providerInitialized = false;

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

  protected applyProviderResult(result: EmbeddingProviderResult): void {
    this.provider = result.provider;
    this.fallbackFrom = result.fallbackFrom;
    this.fallbackReason = result.fallbackReason;
    this.providerUnavailableReason = result.providerUnavailableReason;
    this.providerLifecycle = resolveMemoryProviderLifecycle(result);
    this.providerRuntime = result.runtime;
    this.providerInitialized = true;
    this.providerKey = this.computeProviderKey();
    this.batch = this.resolveBatchConfig();
  }

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

  protected resolveConfiguredFallbackProvider() {
    const currentProviderId = resolveFallbackCurrentProviderId({
      provider: this.provider,
      lifecycle: this.providerLifecycle,
    });
    const fallbackRequest = resolveMemoryFallbackProviderRequest({
      cfg: this.cfg,
      settings: this.settings,
      currentProviderId,
    });
    return { currentProviderId, fallbackRequest };
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
    const existingMeta = this.database.facts.meta;
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
    const isSearchBootstrap = params?.reason === "search-bootstrap";
    const syncProvider = this.syncProviderGeneration
      ? this.syncProviderGeneration.provider
      : this.provider;
    const progress = params?.progress ? this.createSyncProgress(params.progress) : undefined;
    let hasTargetArchiveFiles = hasTargetSessionRequest;
    let recoveringSessionFullRetry = false;
    let syncingSources = false;
    try {
      if (await this.resumeReindex(params)) {
        needsFullReindex = true;
        hasTargetArchiveFiles = false;
        syncingSources = true;
        await this.runInPlaceReindex(progress);
        return;
      }
      if (!needsFullReindex && this.sources.has("sessions")) {
        const excluded = await resolveActiveMemoryRecallSources({
          rows: await this.database.readSourceState({ source: "sessions" }),
          cfg: this.cfg,
          agentId: this.agentId,
        });
        // Invalid helper rows do not need an embedding provider or a forced rebuild.
        // Reconcile them before an unrelated source can fail to embed.
        for (const row of excluded) {
          await this.deleteIndexedFile(row.path, "sessions", row.hash);
        }
      }
      // An unavailable configured provider must not replace semantic vectors
      // with FTS-only rows; fresh and already-FTS-only indexes remain safe.
      this.assertFtsOnlySyncAllowed();

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
      const meta = this.database.facts.meta;
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
      hasTargetArchiveFiles = targetArchiveFiles !== null;
      if (params?.reason === "cli" && !params.force && !hasTargetArchiveFiles) {
        await this.markSessionStartupCatchupDirtyFiles();
      }
      const syncProviderKey = this.syncProviderGeneration
        ? this.syncProviderGeneration.providerKey
        : this.providerKey;
      const syncProviderIdentities =
        this.syncProviderGeneration?.identities ?? this.resolveProviderIndexIdentities();
      const hasIndexedChunks = this.database.facts.hasIndexedChunks;
      const indexIdentity = resolveMemoryIndexIdentityState({
        meta,
        // Also detects provider→FTS-only transitions so orphaned old-model FTS rows are cleaned up.
        provider: syncProvider ? { id: syncProvider.id, model: syncProvider.model } : null,
        providerKey: syncProviderKey ?? undefined,
        providerAliases: syncProviderIdentities.slice(1),
        configuredSources: resolveConfiguredSourcesForMeta(this.sources),
        configuredScopeHash: this.resolveConfiguredMemoryScopeHash(),
        chunkTokens: this.settings.chunking.tokens,
        chunkOverlap: this.settings.chunking.overlap,
        vectorReady,
        hasIndexedChunks,
        ftsTokenizer: this.settings.store.fts.tokenizer,
      });
      if (
        meta &&
        syncProviderKey &&
        canUpgradeMemoryIndexProviderKey(indexIdentity, meta, syncProviderIdentities)
      ) {
        // Retire the legacy cache namespace atomically before any chunking rebuild.
        const database = this.database;
        const upgraded = await database.updateIndexStructure(
          { type: "index.upgradeProviderKey", input: { meta, providerKey: syncProviderKey } },
          () => this.assertDatabaseMutationCurrent(database),
        );
        if (!upgraded) {
          return MEMORY_SYNC_DEFERRED;
        }
      }
      if (hasTargetSessionRequest && !hasTargetArchiveFiles) {
        return;
      }
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
      const hasOnlyFtsChunks = needsFtsOnlyClassification && !this.database.facts.hasSemanticChunks;
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
        performance.now() < this.fullReindexRetryBackoff.retryAt;
      const deferAutomaticFullReindex = retryFullReindexBackedOff && !needsExplicitIdentityReindex;
      if (deferAutomaticFullReindex && !hasTargetArchiveFiles) {
        // Automatic identity repair honors the failure cooldown. An explicit
        // CLI index request still retries immediately.
        this.requestSessionIndexRetry();
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
      syncingSources = true;
      if (needsFullReindex) {
        if (params?.reason !== "cli") {
          this.recordAutomaticRebuild();
        }
        await this.runInPlaceReindex(progress);
        return;
      }

      const shouldSyncMemory = this.sources.has("memory") && (this.dirty || isSearchBootstrap);
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
      if (!syncingSources) {
        throw err;
      }
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
        } else {
          this.requestSessionIndexRetry(true);
        }
        return;
      }
      if (!this.provider && this.fts.enabled && isMemoryEmbeddingOperationError(err)) {
        this.requestSessionIndexRetry();
        this.syncOutcomes.recordFailure(err);
        log.warn(`memory embeddings unavailable; leaving memory index dirty: ${reason}`);
        return;
      }
      throw err;
    } finally {
      // Ordinary sync exits retain live cleanup, including preflight/no-op exits.
      // Full rebuilds finalize their cache with the shadow; preflight failures have no shadow work.
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
      this.requestSessionIndexRetry(true);
      this.syncOutcomes.recordFailure(failure.error);
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
    const { currentProviderId, fallbackRequest } = this.resolveConfiguredFallbackProvider();
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

    this.applyProviderResult({
      ...fallbackResult,
      requestedProvider: currentProviderId,
      fallbackFrom: currentProviderId,
      fallbackReason: reason,
      providerUnavailableReason: undefined,
    });
    log.warn(`memory embeddings: switched to fallback provider (${fallbackRequest.provider})`, {
      reason,
    });
    return true;
  }
}
