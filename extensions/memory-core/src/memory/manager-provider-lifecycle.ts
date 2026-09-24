// Memory Core plugin module owns embedding provider lifecycle.
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  formatErrorMessage,
  readErrorName,
  toErrorObject,
} from "openclaw/plugin-sdk/error-runtime";
import { listRegisteredMemoryEmbeddingProviderAdapters } from "openclaw/plugin-sdk/memory-core-host-embedding-registry";
import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  resolveAgentDir,
  resolveUserPath,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemoryEmbeddingProbeResult,
  MemorySearchRuntimeDebug,
  MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import {
  createEmbeddingProvider,
  resolveEmbeddingProviderAdapterTransport,
  type EmbeddingProvider,
  type EmbeddingProviderRequest,
  type EmbeddingProviderResult,
} from "./embeddings.js";
import { MemoryManagerReloadError } from "./lifecycle.js";
import { runMemoryIndexState } from "./manager-cpu-worker-runtime.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import {
  createDegradedMemoryProviderLifecycle,
  createPendingMemoryProviderLifecycle,
  resolveFallbackCurrentProviderId,
  resolveMemoryFallbackProviderRequest,
  resolveMemoryPrimaryProviderRequest,
  resolveMemoryProviderState,
} from "./manager-provider-state.js";
import type { MemoryEmbeddingProbeCacheEntry } from "./manager-registry.js";
import type { MemoryIndexIdentityState } from "./manager-reindex-state.js";
import type { MemoryRetrievalIndexState } from "./manager-retrieval-read.js";

const EMBEDDING_PROBE_CACHE_TTL_MS = 30_000;
const log = createSubsystemLogger("memory");

export type MemoryEmbeddingProviderRequirement = {
  mode: "fts-only" | "optional" | "required";
  provider: string;
  configuredProvider?: string;
};
export type MemoryEmbeddingBootstrapDebug = NonNullable<
  MemorySearchRuntimeDebug["embeddingBootstrap"]
>;

export function resolveEffectiveMemorySearchSettings(
  settings: ResolvedMemorySearchConfig,
): ResolvedMemorySearchConfig {
  if (settings.provider !== "none" || !settings.store.vector.enabled) {
    return settings;
  }
  return {
    ...settings,
    store: {
      ...settings.store,
      vector: {
        ...settings.store.vector,
        enabled: false,
      },
    },
  };
}

function resolveConfiguredMemoryEmbeddingProvider(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string | undefined {
  const agentEntry = resolveAgentConfig(params.cfg, normalizeAgentId(params.agentId));
  return agentEntry?.memory?.search?.provider ?? params.cfg.memory?.search?.provider;
}

export function resolveMemoryEmbeddingProviderRequirement(params: {
  cfg: OpenClawConfig;
  agentId: string;
  settings: ResolvedMemorySearchConfig;
}): MemoryEmbeddingProviderRequirement {
  const configuredProvider = resolveConfiguredMemoryEmbeddingProvider(params)?.trim();
  if (params.settings.provider === "none" || configuredProvider === "none") {
    return { mode: "fts-only", provider: params.settings.provider };
  }
  const adapterTransport = resolveEmbeddingProviderAdapterTransport(
    params.settings.provider,
    params.cfg,
  );
  if (!configuredProvider || configuredProvider === "auto" || adapterTransport === "local") {
    return { mode: "optional", provider: params.settings.provider };
  }
  return {
    mode: "required",
    provider: params.settings.provider,
    configuredProvider,
  };
}

export abstract class MemoryProviderLifecycle extends MemoryManagerEmbeddingOps {
  protected abstract getEmbeddingProbeOwners(): readonly MemoryEmbeddingProviderAdapter[];
  protected abstract canPublishEmbeddingProbe(): boolean;
  protected abstract readonly embeddingProbeCache: Map<string, MemoryEmbeddingProbeCacheEntry>;
  protected abstract readonly cacheKey: string;
  protected abstract readonly purpose: "default" | "status" | "cli" | "maintenance";
  protected abstract readonly providerRequirement: MemoryEmbeddingProviderRequirement;
  protected abstract readonly requestedProvider: EmbeddingProviderRequest;
  protected abstract providerInitPromise: Promise<void> | null;
  protected abstract providerInitialized: boolean;
  protected abstract embeddingBootstrapFailure?: MemoryEmbeddingBootstrapDebug;
  protected abstract providerRetirementPromise: Promise<void>;
  protected abstract providersPendingRetirement: Set<EmbeddingProvider>;
  protected abstract activeBackgroundSearchSyncs: Set<Promise<void>>;
  protected abstract indexIdentityDirty: boolean;
  protected abstract indexIdentityState: MemoryIndexIdentityState;
  protected abstract syncAdmitted(
    params?: MemorySyncParams,
    options?: { allowEmbeddingBootstrapFallback?: boolean; queuedSessionOwner?: boolean },
  ): Promise<void>;
  protected abstract syncPublishedIndexInBackground(params: { reason: string }): Promise<void>;

  protected applyProviderResult(providerResult: EmbeddingProviderResult): void {
    const providerState = resolveMemoryProviderState(providerResult);
    this.provider = providerState.provider;
    this.fallbackFrom = providerState.fallbackFrom;
    this.fallbackReason = providerState.fallbackReason;
    this.providerUnavailableReason = providerState.providerUnavailableReason;
    this.providerLifecycle = providerState.lifecycle;
    this.providerRuntime = providerState.providerRuntime;
    this.providerInitialized = true;
  }

  protected markEmbeddingBootstrapFailure(
    err: unknown,
    options?: { retainProvider?: boolean; provider?: string },
  ): MemoryEmbeddingBootstrapDebug {
    if (err instanceof MemoryManagerReloadError) {
      throw err;
    }
    const rawErrorName = readErrorName(err).trim();
    const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawErrorName) ? rawErrorName : "";
    const message =
      redactSensitiveText(formatErrorMessage(err), { mode: "tools" }).trim() ||
      "embedding provider initialization failed";
    const reason = redactSensitiveText(
      errorName && errorName !== "Error" ? `${errorName}: ${message}` : message,
      { mode: "tools" },
    );
    // settings.provider is already resolved from "auto"; never trust an unknown
    // error object's provider-shaped field for public diagnostics.
    const provider = options?.provider ?? this.provider?.id ?? this.settings.provider;
    const debug: MemoryEmbeddingBootstrapDebug = {
      ok: false,
      provider,
      reason,
      degradedTo: "keyword-only",
    };
    if (!options?.retainProvider) {
      this.provider = null;
      this.providerRuntime = undefined;
    }
    this.providerInitialized = true;
    this.providerUnavailableReason = reason;
    this.providerLifecycle = createDegradedMemoryProviderLifecycle({
      providerId: provider,
      reason,
    });
    this.embeddingBootstrapFailure = debug;
    this.providerKey = this.computeProviderKey();
    this.batch = this.resolveBatchConfig();
    this.vector.semanticAvailable = false;
    this.cacheProbeResult({ ok: false, error: reason });
    return debug;
  }

  protected async ensureEmbeddingProviderForSearch(
    initialIndexState: MemoryRetrievalIndexState,
    onDebug?: (debug: MemorySearchRuntimeDebug) => void,
  ): Promise<boolean> {
    let indexState = initialIndexState;
    const failure = this.embeddingBootstrapFailure;
    if (failure) {
      const cached = this.getCachedEmbeddingAvailability();
      if (cached?.ok === false) {
        onDebug?.({ backend: "builtin", embeddingBootstrap: failure });
        return true;
      }
    }
    try {
      await this.ensureProviderInitialized();
    } catch (err) {
      if (this.providerRequirement.mode !== "optional") {
        throw err;
      }
      const nextFailure = this.markEmbeddingBootstrapFailure(err);
      onDebug?.({ backend: "builtin", embeddingBootstrap: nextFailure });
      return true;
    }
    if (!failure) {
      return false;
    }
    if (!this.provider) {
      const nextFailure: MemoryEmbeddingBootstrapDebug = {
        ...failure,
        reason: this.providerUnavailableReason ?? failure.reason,
      };
      this.embeddingBootstrapFailure = nextFailure;
      this.cacheProbeResult({ ok: false, error: nextFailure.reason });
      onDebug?.({ backend: "builtin", embeddingBootstrap: nextFailure });
      return true;
    }

    const currentIdentity = this.refreshIndexIdentityDirty({ providerKeyKnown: true, indexState });
    let activeFailure = failure;
    if (currentIdentity.status !== "valid") {
      try {
        await this.syncAdmitted({ reason: "search", force: true });
      } catch (err) {
        const message = redactSensitiveText(formatErrorMessage(err), { mode: "tools" });
        log.warn(`memory sync failed (embedding-bootstrap-recovery): ${message}`);
        activeFailure = this.markEmbeddingBootstrapFailure(err, { retainProvider: true });
      }
      indexState = await this.readRetrievalIndexState();
    }
    if (
      this.refreshIndexIdentityDirty({ providerKeyKnown: true, indexState }).status === "valid" &&
      (await this.confirmEmbeddingBootstrapRecovery())
    ) {
      // A valid existing index skips recovery reindex, so explicitly restore the
      // semantic readiness flag cleared when bootstrap degradation began.
      this.vector.semanticAvailable =
        this.vector.enabled &&
        this.vector.available === true &&
        indexState.vectorState.state === "complete";
      this.clearEmbeddingBootstrapFailureAfterRecovery();
      return false;
    }
    activeFailure = this.embeddingBootstrapFailure ?? activeFailure;
    onDebug?.({ backend: "builtin", embeddingBootstrap: activeFailure });
    return true;
  }

  protected clearEmbeddingBootstrapFailureAfterRecovery(): void {
    this.embeddingBootstrapFailure = undefined;
    this.providerUnavailableReason = undefined;
    if (this.provider) {
      this.providerLifecycle = this.fallbackFrom
        ? {
            mode: "fallback-active",
            providerId: this.provider.id,
            fallbackFrom: this.fallbackFrom,
            reason: this.fallbackReason ?? "fallback activated",
          }
        : { mode: "active", providerId: this.provider.id };
    }
    this.embeddingProbeCache.delete(this.cacheKey);
  }

  protected async adoptPublishedFallbackProviderIfMatched(
    indexState?: MemoryRetrievalIndexState,
  ): Promise<boolean> {
    if (this.fallbackFrom || !this.provider) {
      return false;
    }
    const currentProviderId = resolveFallbackCurrentProviderId({
      provider: this.provider,
      lifecycle: this.providerLifecycle,
    });
    const fallbackRequest = resolveMemoryFallbackProviderRequest({
      cfg: this.cfg,
      settings: this.settings,
      currentProviderId,
    });
    const meta = indexState ? indexState.meta : this.readMeta();
    if (
      !fallbackRequest ||
      !meta ||
      meta.provider !== fallbackRequest.provider ||
      meta.model !== fallbackRequest.model
    ) {
      return false;
    }
    const activated = await this.activateFallbackProvider(
      "published memory index uses the configured fallback provider",
    );
    return (
      activated &&
      this.refreshIndexIdentityDirty({
        providerKeyKnown: this.providerInitialized,
        indexState,
      }).status === "valid"
    );
  }

  protected async confirmEmbeddingBootstrapRecovery(): Promise<boolean> {
    const cached = this.getCachedEmbeddingAvailability();
    if (cached) {
      return cached.ok;
    }
    if (!this.provider) {
      return false;
    }
    try {
      await this.embedBatchWithRetry(["ping"]);
      this.cacheProbeResult({ ok: true });
      return true;
    } catch (err) {
      this.markEmbeddingBootstrapFailure(err, {
        retainProvider: true,
        provider: this.provider.id,
      });
      return false;
    }
  }

  protected async ensureProviderInitialized(): Promise<void> {
    if (this.providerInitialized) {
      const bootstrapRetryDue =
        this.embeddingBootstrapFailure !== undefined &&
        !this.provider &&
        this.getCachedEmbeddingAvailability() === null;
      if (!bootstrapRetryDue) {
        await this.getPendingFallbackProviderInitialization()?.catch(() => undefined);
        return;
      }
      this.resetProviderInitializationForRetry();
    }
    if (this.settings.provider === "none") {
      this.applyProviderResult({
        provider: null,
        requestedProvider: "none",
        providerUnavailableReason: "No embedding provider available (FTS-only mode)",
      });
      this.providerKey = this.computeProviderKey();
      this.batch = this.resolveBatchConfig();
      return;
    }
    if (!this.providerInitPromise) {
      this.providerInitPromise = (async () => {
        await this.getPendingFallbackProviderInitialization()?.catch(() => undefined);
        await this.retireCurrentProvider();
        if (this.closed) {
          return;
        }
        const providerResult = await createEmbeddingProvider({
          createProvider: this.createProvider,
          config: this.cfg,
          agentDir: resolveAgentDir(this.cfg, this.agentId),
          ...(this.acquireLocalService ? { acquireLocalService: this.acquireLocalService } : {}),
          ...resolveMemoryPrimaryProviderRequest({ settings: this.settings }),
        });
        this.applyProviderResult(providerResult);
        this.providerKey = this.computeProviderKey();
        this.batch = this.resolveBatchConfig();
      })();
    }
    try {
      await this.providerInitPromise;
    } catch (err) {
      // Clear the cached rejected promise so subsequent calls can retry
      // initialization instead of being permanently stuck with a stale failure.
      this.providerInitPromise = null;
      throw err;
    } finally {
      if (this.providerInitialized) {
        this.providerInitPromise = null;
      }
    }
  }

  protected resetProviderInitializationForRetry(): void {
    void this.retireCurrentProvider();
    this.providerInitialized = false;
    this.providerInitPromise = null;
    this.providerUnavailableReason = undefined;
    this.providerLifecycle = createPendingMemoryProviderLifecycle(this.requestedProvider);
  }

  protected markLocalEmbeddingProviderDegraded(err: unknown): void {
    if (this.provider?.id !== "local") {
      return;
    }
    const message = formatErrorMessage(err);
    const degradedProvider = this.provider;
    void this.retireCurrentProvider();
    this.providerUnavailableReason = `Local embeddings degraded: ${message}`;
    this.providerLifecycle = createDegradedMemoryProviderLifecycle({
      providerId: degradedProvider.id,
      reason: message,
    });
    this.embeddingProbeCache.delete(this.cacheKey);
    this.providerKey = this.computeProviderKey();
    this.batch = this.resolveBatchConfig();
    this.vector.semanticAvailable = false;
    log.warn("memory embeddings: local provider degraded after transport failure", {
      error: message,
    });
  }

  protected override retireCurrentProvider(): Promise<void> {
    const provider = this.provider;
    if (provider) {
      this.provider = null;
      this.providerRuntime = undefined;
      this.providersPendingRetirement.add(provider);
    }
    if (this.providersPendingRetirement.size === 0) {
      return this.providerRetirementPromise;
    }
    // Provider replacement must wait for the previous worker to exit; otherwise
    // repeated retries can accumulate local workers on constrained hosts.
    const retirement = this.providerRetirementPromise
      .catch(() => {})
      .then(async () => {
        let firstError: unknown;
        let closeFailed = false;
        for (const pendingProvider of this.providersPendingRetirement) {
          try {
            await this.awaitProviderIdle(pendingProvider);
            await pendingProvider.close?.();
            this.releaseProvider(pendingProvider);
            this.providersPendingRetirement.delete(pendingProvider);
          } catch (err) {
            if (!closeFailed) {
              firstError = err;
            }
            closeFailed = true;
          }
        }
        if (closeFailed) {
          throw toErrorObject(firstError, "Embedding provider retirement failed");
        }
      });
    this.providerRetirementPromise = retirement;
    void retirement.catch((err: unknown) => {
      log.warn(`memory embeddings: failed to close previous provider: ${formatErrorMessage(err)}`);
    });
    return retirement;
  }

  protected async drainPendingProviderRetirements(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (
      let attempt = 0;
      attempt < 2 && (this.provider !== null || this.providersPendingRetirement.size > 0);
      attempt += 1
    ) {
      try {
        await this.retireCurrentProvider();
      } catch (err) {
        errors.push(err);
        log.warn(`memory close: pending manager work failed: ${formatErrorMessage(err)}`);
      }
    }
    return errors;
  }

  protected isRequiredProviderUnavailable(): boolean {
    return this.providerRequirement.mode === "required" && !this.provider;
  }

  protected buildRequiredProviderUnavailableError(operation: "search" | "sync"): Error {
    const registeredProviderIds = listRegisteredMemoryEmbeddingProviderAdapters()
      .map((adapter) => adapter.id)
      .toSorted();
    const registeredProviders =
      registeredProviderIds.length > 0 ? registeredProviderIds.join(",") : "none";
    const reason =
      this.providerUnavailableReason ??
      (this.providerLifecycle.mode === "fts-only"
        ? this.providerLifecycle.reason
        : "provider is unavailable");
    return new Error(
      `Memory ${operation} unavailable: embedding provider "${this.settings.provider}" is configured but unavailable. ` +
        `Reason: ${reason}. ` +
        `agentId=${this.agentId} purpose=${this.purpose} lifecycle=${JSON.stringify(this.providerLifecycle)} ` +
        `registeredMemoryEmbeddingProviders=${registeredProviders}`,
    );
  }

  protected assertRequiredProviderAvailable(operation: "search" | "sync"): void {
    if (this.isRequiredProviderUnavailable()) {
      const error = this.buildRequiredProviderUnavailableError(operation);
      this.resetProviderInitializationForRetry();
      throw error;
    }
  }

  protected readRetrievalIndexState(signal?: AbortSignal): Promise<MemoryRetrievalIndexState> {
    return runMemoryIndexState(
      { agentId: this.agentId, databasePath: resolveUserPath(this.settings.store.databasePath) },
      signal,
    );
  }

  protected refreshIndexIdentityDirty(params?: {
    providerKeyKnown?: boolean;
    indexState?: MemoryRetrievalIndexState;
  }) {
    const provider =
      this.settings.provider === "none"
        ? null
        : this.providerInitialized
          ? this.provider
            ? { id: this.provider.id, model: this.provider.model }
            : null
          : undefined;
    const state = this.resolveCurrentIndexIdentityState({
      ...(provider !== undefined ? { provider } : {}),
      providerKeyKnown: params?.providerKeyKnown,
      ...(params?.indexState
        ? { meta: params.indexState.meta, hasIndexedChunks: params.indexState.hasIndexedChunks }
        : {}),
    });
    this.indexIdentityState = state;
    this.indexIdentityDirty =
      state.status === "mismatched" ||
      (state.status === "missing" &&
        (this.sources.has("memory") ||
          (params?.indexState?.hasIndexedChunks ?? this.hasIndexedChunks())));
    return state;
  }

  protected refreshKeywordFallbackIndexIdentity(indexState?: MemoryRetrievalIndexState) {
    const meta = indexState ? indexState.meta : this.readMeta();
    const state = this.resolveCurrentIndexIdentityState({
      meta,
      provider: meta && meta.provider !== "none" ? { id: meta.provider, model: meta.model } : null,
      providerKeyKnown: false,
      vectorReady: false,
      ...(indexState ? { hasIndexedChunks: indexState.hasIndexedChunks } : {}),
    });
    this.indexIdentityState = state;
    this.indexIdentityDirty =
      state.status === "mismatched" ||
      (state.status === "missing" &&
        (this.sources.has("memory") || (indexState?.hasIndexedChunks ?? this.hasIndexedChunks())));
    return state;
  }

  protected async awaitManagerIdle(): Promise<void> {
    if (this.activeManagerOperations > 0) {
      await new Promise<void>((resolve) => {
        this.managerIdleWaiters.add(resolve);
      });
    }
    // CLI request teardown must not wait after a published search result is ready;
    // its detached task owns a separate maintenance manager. Persistent managers
    // still drain maintenance before closing shared resources.
    while (this.purpose !== "cli" && this.activeBackgroundSearchSyncs.size > 0) {
      await Promise.all(Array.from(this.activeBackgroundSearchSyncs));
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    return await this.withManagerOperation(async () => {
      if (!this.vector.enabled) {
        this.vector.semanticAvailable = false;
        return false;
      }
      await this.ensureProviderInitialized();
      // FTS-only mode: vector search not available
      if (!this.provider) {
        this.vector.semanticAvailable = false;
        return false;
      }
      const ready = await this.probeVectorStoreAvailabilityAdmitted();
      this.vector.semanticAvailable = ready;
      return ready;
    });
  }

  async probeVectorStoreAvailability(): Promise<boolean> {
    return await this.withManagerOperation(
      async () => await this.probeVectorStoreAvailabilityAdmitted(),
    );
  }

  private async probeVectorStoreAvailabilityAdmitted(): Promise<boolean> {
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    return await this.ensureVectorReady();
  }

  protected cacheProbeResult(result: MemoryEmbeddingProbeResult): MemoryEmbeddingProbeResult {
    if (!this.canPublishEmbeddingProbe()) {
      return result;
    }
    const checkedAtMs = Date.now();
    this.embeddingProbeCache.set(this.cacheKey, {
      result,
      adapters: this.getEmbeddingProbeOwners(),
      checkedAtMs,
      expireAtMs: checkedAtMs + EMBEDDING_PROBE_CACHE_TTL_MS,
    });
    return result;
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    const cached = this.embeddingProbeCache.get(this.cacheKey);
    if (!cached) {
      return null;
    }
    const nowMs = Date.now();
    if (nowMs >= cached.expireAtMs) {
      this.embeddingProbeCache.delete(this.cacheKey);
      return null;
    }
    return {
      ...cached.result,
      checked: true,
      cached: true,
      checkedAtMs: cached.checkedAtMs,
      cacheExpiresAtMs: cached.expireAtMs,
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return await this.withManagerOperation(async () => {
      const cached = this.getCachedEmbeddingAvailability();
      if (cached) {
        return cached;
      }
      await this.ensureProviderInitialized();
      // Diagnostics must describe the provider search actually uses. A published index that
      // belongs to the configured fallback is adopted on the search path, so adopt it here
      // too instead of probing a provider this workspace's index cannot be read with.
      await this.adoptPublishedFallbackProviderIfMatched();
      // FTS-only mode: embeddings not available but search still works
      if (!this.provider) {
        return this.cacheProbeResult({
          ok: false,
          error:
            this.providerUnavailableReason ?? "No embedding provider available (FTS-only mode)",
        });
      }
      try {
        await this.embedBatchWithRetry(["ping"]);
        return this.cacheProbeResult({ ok: true });
      } catch (err) {
        const message = formatErrorMessage(err);
        return this.cacheProbeResult({ ok: false, error: message });
      }
    });
  }
}
