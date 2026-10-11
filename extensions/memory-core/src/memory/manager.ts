import { formatErrorMessage, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  resolveUserPath,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  type MemoryProviderStatus,
  type MemorySearchManager,
  type MemorySyncParams,
  type MemoryWorkspaceFiles,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { withOpenClawAgentDatabaseWrite } from "openclaw/plugin-sdk/sqlite-runtime";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { getMemoryManagerLifecycle } from "./lifecycle.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { isMemoryEmbeddingOperationError } from "./manager-embedding-errors.js";
import {
  resolveEffectiveMemorySearchSettings,
  resolveMemoryEmbeddingProviderRequirement,
  type MemoryEmbeddingProviderRequirement,
} from "./manager-provider-lifecycle.js";
import { getLocalEmbeddingRuntimeFacts } from "./manager-provider-runtime-facts.js";
import type { MemoryProviderLifecycleState } from "./manager-provider-state.js";
import {
  MemoryManagerRegistry,
  type MemoryManagerProviderFactory,
  normalizeMemoryIndexManagerPurpose,
  resolveMemoryIndexManagerCacheKey,
  type MemoryIndexManagerPurpose,
} from "./manager-registry.js";
import { waitForMemoryReindexLock } from "./manager-reindex-lock.js";
import type { MemoryIndexIdentityState } from "./manager-reindex-state.js";
import { runMemorySearchMaintenance } from "./manager-search-maintenance.js";
import { MemorySearchOrchestration } from "./manager-search-orchestration.js";
import {
  collectMemoryStatusAggregate,
  collectMemoryStorageStatus,
  resolveStatusProviderInfo,
} from "./manager-status-state.js";
import type { MemoryEmbeddingBatchConfig } from "./manager-sync-base.js";
import {
  MemoryTargetedSessionSyncQueue,
  hasTargetedSessionSyncParams,
} from "./manager-sync-control.js";
import type { MemorySyncOutcome } from "./manager-sync-outcome.js";
import { resolvePersistedMemoryVectorIndexState } from "./manager-vector-rebuild-state.js";
import type { MemoryCoreRuntimeHost } from "./runtime-host.js";

const log = createSubsystemLogger("memory");

export class MemoryIndexManager extends MemorySearchOrchestration implements MemorySearchManager {
  private readonly managerRegistry: MemoryManagerRegistry<MemoryIndexManager>;
  protected readonly createProvider: MemoryManagerProviderFactory = (adapter, create) =>
    this.managerRegistry.createProvider(this, adapter, create);
  protected releaseProvider(provider: EmbeddingProvider): void {
    this.managerRegistry.releaseProvider(this, provider);
  }
  protected canPublishEmbeddingProbe(): boolean {
    return this.managerRegistry.canPublishProbe(this);
  }
  protected getEmbeddingProbeOwners() {
    return this.managerRegistry.getProbeOwners(this);
  }
  protected get embeddingProbeCache() {
    return this.managerRegistry.embeddingProbeCache;
  }
  protected readonly cacheKey: string;
  protected readonly purpose: MemoryIndexManagerPurpose;
  protected override readonly acquireLocalService?: MemoryCoreAcquireLocalService;
  private readonly backgroundRunner?: MemoryCoreRuntimeHost["runInBackgroundContext"];
  protected readonly runInBackgroundContext = <T>(run: () => T): T => {
    if (!this.backgroundRunner) {
      throw new Error("Memory background work requires a plugin lifecycle owner");
    }
    return this.backgroundRunner(run);
  };
  protected override readonly memoryFiles?: MemoryWorkspaceFiles;
  protected readonly cfg: OpenClawConfig;
  protected readonly agentId: string;
  protected readonly workspaceDir: string;
  protected readonly settings: ResolvedMemorySearchConfig;
  protected readonly providerRequirement: MemoryEmbeddingProviderRequirement;
  private closePromise: Promise<void> | null = null;
  private publishedDatabaseReleased = false;
  protected providerUnavailableReason?: string;
  protected override providerLifecycle: MemoryProviderLifecycleState;
  protected batch: MemoryEmbeddingBatchConfig;
  protected publishedDatabase: MemoryIndexDatabase;
  protected readonly cache: { enabled: boolean; maxEntries?: number };
  private syncing: Promise<void> | null = null;
  private syncingMemoryWatchGeneration = 0;
  private readonly sessionSyncQueue = new MemoryTargetedSessionSyncQueue({
    isClosed: () => this.closing || this.closed,
    getSyncing: () => this.syncing,
    sync: (params) => this.syncAdmitted(params, { queuedSessionOwner: true }),
  });
  protected indexIdentityState: MemoryIndexIdentityState;

  static async get(params: {
    memoryFiles?: MemoryWorkspaceFiles;
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: MemoryIndexManagerPurpose;
    inspectSources?: boolean;
    acquireLocalService?: MemoryCoreAcquireLocalService;
    runInBackgroundContext?: MemoryCoreRuntimeHost["runInBackgroundContext"];
    maintenanceSource?: MemoryIndexManager;
  }): Promise<MemoryIndexManager | null> {
    const source = params.maintenanceSource;
    const memoryFiles = source?.memoryFiles ?? params.memoryFiles;
    memoryFiles?.assertCurrent();
    const cfg = source?.cfg ?? params.cfg;
    const agentId = source?.agentId ?? normalizeAgentId(params.agentId);
    const purpose = normalizeMemoryIndexManagerPurpose(params.purpose);
    const managerRegistry = source?.managerRegistry ?? getMemoryIndexManagerRegistry();
    return await managerRegistry.acquire(
      { agentId, purpose },
      {
        prepare: () => {
          const settings = source?.settings ?? resolveMemorySearchConfig(cfg, agentId);
          if (!settings) {
            return null;
          }
          const workspaceDir = source?.workspaceDir ?? resolveAgentWorkspaceDir(cfg, agentId);
          const providerRequirement =
            source?.providerRequirement ??
            resolveMemoryEmbeddingProviderRequirement({
              cfg,
              agentId,
              settings,
            });
          const key = resolveMemoryIndexManagerCacheKey({
            agentId,
            workspaceDir,
            settings,
            providerRequirement,
            purpose,
            acquireLocalService: params.acquireLocalService,
          });
          const databaseOptions = MemoryIndexDatabase.captureWriteOptions(
            agentId,
            settings.store.databasePath,
            source?.publishedDatabase,
          );
          return {
            key,
            create: async () => {
              let manager: MemoryIndexManager | undefined;
              try {
                if (source && (!source.publishedDatabase.db.isOpen || purpose !== "maintenance")) {
                  throw new Error("Memory maintenance source connection is unavailable");
                }
                const effectiveSettings = resolveEffectiveMemorySearchSettings(settings);
                const publishedDatabase = await MemoryIndexDatabase.openPublished({
                  agentId,
                  writeOptions: databaseOptions,
                  readOnly: purpose === "status",
                  allowExtension: effectiveSettings.store.vector.enabled,
                  maintenanceSource: source?.publishedDatabase,
                  schema: {
                    cacheEnabled: effectiveSettings.cache.enabled,
                    ftsEnabled: effectiveSettings.query.hybrid.enabled,
                    ftsTokenizer: effectiveSettings.store.fts.tokenizer,
                  },
                });
                manager = new MemoryIndexManager({
                  managerRegistry,
                  cacheKey: key,
                  cfg,
                  agentId,
                  workspaceDir,
                  memoryFiles,
                  settings,
                  providerRequirement,
                  purpose,
                  acquireLocalService: params.acquireLocalService,
                  runInBackgroundContext: source?.backgroundRunner ?? params.runInBackgroundContext,
                  maintenanceSource: source,
                  databaseOptions,
                  publishedDatabase,
                });
                managerRegistry.track(manager, key);
                // Filesystem discovery is asynchronous and must not hold the
                // agent database's write admission while attaching watchers.
                await manager.memoryWatcherReady;
                if (params.inspectSources) {
                  await manager.inspectDiagnosticSourceState();
                }
                memoryFiles?.assertCurrent();
                return manager;
              } catch (error) {
                try {
                  await manager?.close();
                } catch (cleanupError) {
                  throw new AggregateError(
                    [error, cleanupError],
                    "Memory manager preparation cleanup failed",
                    { cause: cleanupError },
                  );
                }
                throw error;
              }
            },
            reuse: ({ closing, closed, db, memoryFiles: files, backgroundRunner }) =>
              !closing &&
              !closed &&
              db.isOpen &&
              files === memoryFiles &&
              backgroundRunner === (source?.backgroundRunner ?? params.runInBackgroundContext),
          };
        },
      },
    );
  }

  private constructor(params: {
    memoryFiles?: MemoryWorkspaceFiles;
    managerRegistry: MemoryManagerRegistry<MemoryIndexManager>;
    cacheKey: string;
    cfg: OpenClawConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerRequirement: MemoryEmbeddingProviderRequirement;
    purpose: MemoryIndexManagerPurpose;
    acquireLocalService?: MemoryCoreAcquireLocalService;
    runInBackgroundContext?: MemoryCoreRuntimeHost["runInBackgroundContext"];
    maintenanceSource?: MemoryIndexManager;
    databaseOptions: Parameters<typeof withOpenClawAgentDatabaseWrite>[0] & { path: string };
    publishedDatabase: MemoryIndexDatabase;
  }) {
    super(params.maintenanceSource?.automaticRebuildNotice);
    this.managerRegistry = params.managerRegistry;
    const effectiveSettings = resolveEffectiveMemorySearchSettings(params.settings);
    const dbPath = params.databaseOptions.path;
    this.cacheKey = params.cacheKey;
    this.acquireLocalService = params.acquireLocalService;
    this.backgroundRunner = params.runInBackgroundContext;
    this.purpose = params.purpose;
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.memoryFiles = params.memoryFiles;
    this.settings = {
      ...effectiveSettings,
      store: { ...effectiveSettings.store, databasePath: dbPath },
    };
    this.providerRequirement = params.providerRequirement;
    this.providerLifecycle = { mode: "pending", requestedProvider: this.settings.provider };
    for (const memorySource of effectiveSettings.sources) {
      this.sources.add(memorySource);
    }
    this.publishedDatabase = params.publishedDatabase;
    try {
      this.providerKey = this.computeProviderKey();
      this.cache = {
        enabled: effectiveSettings.cache.enabled,
        maxEntries: effectiveSettings.cache.maxEntries,
      };
      this.vector.enabled = effectiveSettings.store.vector.enabled;
      this.vector.extensionPath = effectiveSettings.store.vector.extensionPath;
      const meta = this.readMeta();
      if (meta?.vectorDims) {
        this.vector.dims = meta.vectorDims;
      }
      this.indexIdentityState = this.resolveCurrentIndexIdentityState({
        meta,
        providerKeyKnown: false,
      });
      this.indexIdentityDirty =
        this.indexIdentityState.status === "mismatched" ||
        (this.indexIdentityState.status === "missing" && this.sources.has("memory"));
      const transient = this.purpose !== "default";
      const invalidatedSources = new Set(
        (this.database.hasIndex
          ? (this.db
              .prepare("SELECT DISTINCT source FROM memory_index_sources WHERE hash = ''")
              .all() as Array<{ source?: unknown }>)
          : []
        ).flatMap((row) =>
          row.source === "memory" || row.source === "sessions" ? [row.source] : [],
        ),
      );
      this.memorySourceProvenanceRepairPending =
        this.sources.has("memory") && invalidatedSources.has("memory");
      this.dirty =
        (this.sources.has("memory") && (!transient || !meta)) ||
        this.memorySourceProvenanceRepairPending;
      if (this.sources.has("sessions") && invalidatedSources.has("sessions")) {
        // Migration cannot map a durable session source path back to one live
        // transcript file. Carry a full-session retry so unchanged and deleted
        // transcripts both converge on the next startup/search sync.
        this.sessionsDirty = true;
        this.sessionsFullRetryDirty = true;
      }
      this.batch = this.resolveBatchConfig();
      if (!transient) {
        this.runInBackgroundContext(() => {
          this.ensureWatcher();
          this.ensureSessionListener();
          this.ensureIntervalSync();
          void this.runInBackgroundContext(() => this.ensureSessionStartupCatchup()).catch(
            (err: unknown) => {
              log.warn("memory session startup catch-up failed: " + String(err));
            },
          );
        });
      }
    } catch (err) {
      this.publishedDatabase.release();
      throw err;
    }
  }

  async sync(params?: MemorySyncParams): Promise<void> {
    if (this.purpose === "status") {
      throw new Error("Memory status managers are read-only");
    }
    if (this.closing || this.closed) {
      return;
    }
    // Close must drain accepted syncs through provider initialization and final writes.
    return await this.withManagerOperation(async () => {
      if (hasTargetedSessionSyncParams(params) && this.sessionSyncQueue.hasPending) {
        // A failed queued batch stays manager-owned. Route the next targeted
        // call through the queue even while idle so it adopts that retained work.
        return await this.sessionSyncQueue.enqueue(params);
      }
      return await this.syncAdmitted(params);
    });
  }

  protected async syncPublishedIndexInBackground(params: { reason: string }): Promise<void> {
    if (this.syncing) {
      return await this.syncing;
    }
    await this.syncOutcomes.track(() =>
      runMemorySearchMaintenance({
        reason: params.reason,
        takeDirtyGeneration: () => this.takeSearchMaintenanceRequest(),
        restoreDirtyGeneration: (generation) => this.adoptReindexRetryState(generation),
        acquireManager: () =>
          MemoryIndexManager.get({
            cfg: this.cfg,
            agentId: this.agentId,
            purpose: "maintenance",
            acquireLocalService: this.acquireLocalService,
            maintenanceSource: this,
          }),
      }),
    );
  }

  protected async syncAdmitted(
    params?: MemorySyncParams,
    options?: {
      allowEmbeddingBootstrapFallback?: boolean;
      queuedSessionOwner?: boolean;
    },
  ): Promise<void> {
    if (this.syncing) {
      if (hasTargetedSessionSyncParams(params)) {
        if (options?.queuedSessionOwner) {
          // Another caller claimed the sync slot after this queue owner was
          // created. Wait for it, then retry admission instead of enqueueing
          // into the promise that is already awaiting this call.
          await this.syncing.catch(() => undefined);
          if (this.closing || this.closed) {
            return;
          }
          return await this.syncAdmitted(params, options);
        }
        return this.sessionSyncQueue.enqueue(params);
      }
      try {
        await this.syncing;
        // Watch events accepted after source planning belong to the next pass.
        // Joining the old promise alone would strand them until another search.
        if (
          params?.reason === "watch" &&
          this.dirty &&
          !this.closing &&
          !this.closed &&
          this.memoryWatchGeneration > this.syncingMemoryWatchGeneration
        ) {
          return await this.syncAdmitted(params, options);
        }
        return;
      } catch (err) {
        if (
          options?.allowEmbeddingBootstrapFallback &&
          this.providerRequirement.mode === "optional" &&
          (!this.providerInitialized || this.embeddingBootstrapFailure !== undefined)
        ) {
          if (!this.embeddingBootstrapFailure) {
            this.markEmbeddingBootstrapFailure(err);
          }
          return await this.syncAdmitted(params, options);
        }
        throw err;
      }
    }
    // An intentional no-progress pass may remain dirty. Only newly accepted
    // watch facts can admit another pass; joined callers cannot spin on dirty.
    this.syncingMemoryWatchGeneration = this.memoryWatchGeneration;
    const run = async () => {
      let outcome: MemorySyncOutcome;
      await this.publishedDatabase.withPublicationGeneration(async () => {
        const hadBootstrapFailure = this.embeddingBootstrapFailure !== undefined;
        let forceFtsOnly =
          this.embeddingBootstrapFailure !== undefined &&
          this.getCachedEmbeddingAvailability()?.ok === false;
        if (!forceFtsOnly) {
          try {
            await this.ensureProviderInitialized();
          } catch (err) {
            if (this.providerRequirement.mode !== "optional") {
              throw err;
            }
            // Background indexing must establish optional keyword fallback before the first search.
            this.markEmbeddingBootstrapFailure(err);
            forceFtsOnly = true;
          }
          if (hadBootstrapFailure && !this.provider) {
            this.refreshEmbeddingBootstrapFailure(this.embeddingBootstrapFailure!);
            forceFtsOnly = true;
          }
        }

        const runGeneration = async (keywordOnly: boolean) => {
          // Reset must not overtake embeddings awaiting their final incremental writes.
          // All sync generations own the existing maintenance lease through cleanup.
          const dbPath = resolveUserPath(this.settings.store.databasePath);
          const lock = await waitForMemoryReindexLock(dbPath, { waitForActive: true });
          try {
            await this.publishedDatabase.closePublicationWorker();
            this.beginSyncProviderGeneration({ forceFtsOnly: keywordOnly });
            try {
              return await this.runSync(params).then(
                async (syncOutcome) => {
                  await this.publishedDatabase.closePublicationWorker();
                  return syncOutcome;
                },
                async (error: unknown) => {
                  const [cleanup] = await Promise.allSettled([
                    this.publishedDatabase.closePublicationWorker(),
                  ]);
                  if (cleanup.status === "rejected") {
                    throw new AggregateError(
                      [error, cleanup.reason],
                      `${String(error)}; Memory sync cleanup failed: ${String(cleanup.reason)}`,
                      { cause: error },
                    );
                  }
                  throw error;
                },
              );
            } finally {
              this.endSyncProviderGeneration();
            }
          } finally {
            await lock.release();
          }
        };
        try {
          outcome = await runGeneration(forceFtsOnly);
        } catch (err) {
          const canDegrade =
            this.providerRequirement.mode === "optional" && isMemoryEmbeddingOperationError(err);
          if (!canDegrade) {
            throw err;
          }
          const failedProvider = this.provider?.id ?? this.settings.provider;
          this.markEmbeddingBootstrapFailure(err, {
            retainProvider: this.provider !== null,
            provider: failedProvider,
          });
          if (!options?.allowEmbeddingBootstrapFallback && !hadBootstrapFailure) {
            throw err;
          }
          forceFtsOnly = true;
          outcome = await runGeneration(true);
        }

        if (
          hadBootstrapFailure &&
          !forceFtsOnly &&
          this.provider &&
          this.refreshIndexIdentityDirty({ providerKeyKnown: true }).status === "valid" &&
          (await this.confirmEmbeddingBootstrapRecovery())
        ) {
          this.clearEmbeddingBootstrapFailureAfterRecovery();
        }
      });
      return outcome;
    };
    this.syncing = this.syncOutcomes.track(run, true).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  status(): MemoryProviderStatus {
    if (this.closing || this.closed) {
      throw new Error("Memory index manager is closed");
    }
    return this.withPublishedDatabase(() => this.publishedStatus());
  }

  private publishedStatus(): MemoryProviderStatus {
    if (this.embeddingBootstrapFailure) {
      this.refreshKeywordFallbackIndexIdentity();
    } else {
      this.refreshIndexIdentityDirty({
        providerKeyKnown: this.providerInitialized,
      });
    }
    const sourceFilter = this.buildSourceFilter();
    const statusDb = this.database.hasIndex ? this.db : undefined;
    const aggregateState = collectMemoryStatusAggregate({
      db: statusDb,
      sources: this.sources,
      sourceFilterSql: sourceFilter.sql,
      sourceFilterParams: sourceFilter.params,
      // Source inspection is explicit; routine query status must stay count-only.
      includeChunkBytes: this.sourceInspections.size > 0,
    });

    // Status projects the effective keyword-only search mode while degraded.
    // Sync generations still snapshot this.provider so recovery can rebuild vectors.
    const providerInfo = resolveStatusProviderInfo({
      provider: this.embeddingBootstrapFailure ? null : this.provider,
      providerInitialized: this.embeddingBootstrapFailure ? true : this.providerInitialized,
      requestedProvider: this.settings.provider,
      resolveConfiguredModel: () =>
        this.resolveConfiguredIndexIdentity()?.provider.model || this.settings.model,
    });
    const storage =
      this.sourceInspections.size > 0
        ? collectMemoryStorageStatus(statusDb, resolveUserPath(this.settings.store.databasePath))
        : undefined;
    return {
      backend: "builtin",
      files: aggregateState.files,
      chunks: aggregateState.chunks,
      dirty:
        this.dirty ||
        this.sessionsDirty ||
        this.indexIdentityDirty ||
        this.syncing !== null ||
        this.activeBackgroundSearchSyncs.size > 0,
      lastSyncError: this.syncOutcomes.lastError,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.databasePath,
      storage,
      provider: providerInfo.provider,
      model: providerInfo.model,
      requestedProvider: this.settings.provider,
      sources: Array.from(this.sources),
      extraPaths: this.settings.extraPaths,
      sourceCounts: aggregateState.sourceCounts.map((entry) =>
        Object.assign(entry, this.sourceInspections.get(entry.source) ?? {}),
      ),
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries:
              storage?.embeddingCacheEntries ??
              (
                statusDb
                  ?.prepare(`SELECT COUNT(*) as c FROM ${MEMORY_EMBEDDING_CACHE_TABLE}`)
                  .get() as { c: number } | undefined
              )?.c ??
              0,
            maxEntries: this.cache.maxEntries,
          }
        : { enabled: false, maxEntries: this.cache.maxEntries },
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
        error: this.fts.loadError,
      },
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
        : undefined,
      vector: {
        enabled: this.vector.enabled,
        index: statusDb
          ? resolvePersistedMemoryVectorIndexState({
              db: this.db,
              vectorTable: MEMORY_INDEX_VECTOR_TABLE,
              metaVectorDims: this.vector.dims,
              hasSemanticChunks: this.hasSemanticChunks(),
            })
          : { state: "empty" },
        storeAvailable: this.vector.available ?? undefined,
        semanticAvailable: this.vector.semanticAvailable,
        available: this.vector.semanticAvailable,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
      batch: {
        enabled: this.batch.enabled,
        failures: this.batchFailure.count,
        limit: this.batchFailureLimit,
        wait: this.batch.wait,
        concurrency: this.batch.concurrency,
        pollIntervalMs: this.batch.pollIntervalMs,
        timeoutMs: this.batch.timeoutMs,
        lastError: this.batchFailure.lastError,
        lastProvider: this.batchFailure.lastProvider,
      },
      custom: {
        watcher: this.memoryWatcherHealth,
        llamaCppRuntime: getLocalEmbeddingRuntimeFacts(this.provider),
        searchMode: providerInfo.searchMode,
        providerState: this.providerLifecycle,
        providerUnavailableReason: this.providerUnavailableReason,
        indexIdentity: this.indexIdentityState,
        automaticRebuildNotice: this.automaticRebuildNotice,
      },
    };
  }

  async close(): Promise<void> {
    const existingClose = this.closePromise;
    if (existingClose) {
      await existingClose;
      return;
    }
    const closeOperation = this.withPublishedDatabase(() =>
      this.publishedDatabaseReleased ? this.retryFailedClose() : this.closeOnce(),
    );
    this.closePromise = closeOperation;
    try {
      await closeOperation;
      this.managerRegistry.deleteIfCurrent(this.cacheKey, this);
    } catch (err) {
      if (this.closePromise === closeOperation) {
        this.closePromise = null;
      }
      throw err;
    }
  }

  private async retryFailedClose(): Promise<void> {
    const errors: unknown[] = [];
    // A retained observer failure must not strand independently owned resources.
    await this.closeWatchResources().catch((error: unknown) => errors.push(error));
    const retirementErrors = await this.drainPendingProviderRetirements();
    if (this.providersPendingRetirement.size > 0) {
      errors.push(toErrorObject(retirementErrors.at(-1), "Embedding provider retirement failed"));
    }
    if (!this.publishedDatabaseReleased) {
      try {
        await this.publishedDatabase.closePublicationWorker();
        this.publishedDatabase.release();
        this.publishedDatabaseReleased = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Memory manager cleanup failed");
    }
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    this.sessionSyncQueue.clear();
    await this.awaitManagerIdle();
    this.closed = true;
    const pendingProviderInit = this.providerInitPromise;
    const pendingFallbackInit = this.fallbackProviderInitPromise;
    const reportPendingWorkError = (err: unknown) => {
      log.warn(`memory close: pending manager work failed: ${formatErrorMessage(err)}`);
    };
    await pendingProviderInit?.catch(reportPendingWorkError);
    await pendingFallbackInit?.catch(reportPendingWorkError);
    // Initialization may attach sync work; observe its promise only after it settles.
    await this.syncing?.catch(reportPendingWorkError);
    await this.retryFailedClose();
  }
}

// Provider layers depend on registry contracts; concrete assembly stays with this manager.
const managerRegistryStore = createPluginRuntimeStore<MemoryManagerRegistry<MemoryIndexManager>>({
  key: "memory-core:manager-registry",
  errorMessage: "Memory manager registry is not initialized",
});

export function getMemoryIndexManagerRegistry(): MemoryManagerRegistry<MemoryIndexManager> {
  let registry = managerRegistryStore.tryGetRuntime();
  if (!registry) {
    registry = new MemoryManagerRegistry(getMemoryManagerLifecycle());
    managerRegistryStore.setRuntime(registry);
  }
  return registry;
}
