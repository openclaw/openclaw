// Memory Core plugin module owns manager cache and close serialization.
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemoryEmbeddingProbeResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  resolveMemoryCoreLocalServiceHostIdentity,
  type MemoryCoreAcquireLocalService,
} from "./embedding-local-service.js";
import {
  MemoryManagerReloadError,
  prepareMemoryManagerReload,
  type MemoryManagerLifecycle,
  type MemoryReloadState,
} from "./lifecycle.js";

const log = createSubsystemLogger("memory");

export type MemoryIndexManagerPurpose = "default" | "status" | "cli" | "maintenance";

export function isTransientMemoryIndexManagerPurpose(purpose: MemoryIndexManagerPurpose): boolean {
  return purpose !== "default";
}

export function normalizeMemoryIndexManagerPurpose(
  purpose: MemoryIndexManagerPurpose | undefined,
): MemoryIndexManagerPurpose {
  return purpose === "status" || purpose === "cli" || purpose === "maintenance"
    ? purpose
    : "default";
}

type ClosableMemoryManager = {
  close(): Promise<void>;
};

type PreparedMemoryManager<T extends ClosableMemoryManager> = {
  key: string;
  create: () => Promise<T> | T;
  reuse: (manager: T) => boolean;
};

type MemoryManagerRegistryCallbacks<T extends ClosableMemoryManager> = {
  prepare: () => Promise<PreparedMemoryManager<T> | null> | PreparedMemoryManager<T> | null;
};

export function resolveMemoryIndexManagerCacheKey(params: {
  agentId: string;
  workspaceDir: string;
  settings: ResolvedMemorySearchConfig;
  providerRequirement: unknown;
  purpose: MemoryIndexManagerPurpose;
  acquireLocalService?: MemoryCoreAcquireLocalService;
}): string {
  return [
    params.agentId,
    params.workspaceDir,
    JSON.stringify(params.settings),
    JSON.stringify(params.providerRequirement),
    resolveMemoryCoreLocalServiceHostIdentity(params.acquireLocalService),
    params.purpose,
  ].join(":");
}

export type MemoryEmbeddingProbeCacheEntry = {
  result: MemoryEmbeddingProbeResult;
  adapters: readonly MemoryEmbeddingProviderAdapter[];
  checkedAtMs: number;
  expireAtMs: number;
};

type ProviderFactory = () => Promise<MemoryEmbeddingProviderCreateResult>;
export type MemoryManagerProviderFactory = (
  adapter: MemoryEmbeddingProviderAdapter,
  create: ProviderFactory,
) => Promise<MemoryEmbeddingProviderCreateResult>;

type ManagerOwnership = {
  key: string;
  pending: Map<object, MemoryEmbeddingProviderAdapter>;
  providers: Map<MemoryEmbeddingProvider, MemoryEmbeddingProviderAdapter>;
  failedAdapters: Set<MemoryEmbeddingProviderAdapter>;
  retiring: boolean;
};

type MemoryReloadChange = Parameters<NonNullable<MemoryPluginRuntime["prepareReload"]>>[0];
export class MemoryManagerRegistry<T extends ClosableMemoryManager> {
  readonly embeddingProbeCache = new Map<string, MemoryEmbeddingProbeCacheEntry>();
  private readonly cache = new Map<string, T>();
  private readonly scopeOperations = new Map<string, Promise<void>>();
  private closePromise: Promise<void> | null = null;
  private closeFailed = false;
  private readonly managers = new Map<T, ManagerOwnership>();
  constructor(private readonly lifecycle: MemoryManagerLifecycle = {}) {
    lifecycle.prepare = (reload) => this.prepareManagersForReload(reload);
  }

  private get reload() {
    return this.lifecycle.reload;
  }

  track(manager: T, key: string): ManagerOwnership {
    let owner = this.managers.get(manager);
    if (!owner) {
      owner = {
        key,
        pending: new Map(),
        providers: new Map(),
        failedAdapters: new Set(),
        retiring: false,
      };
      this.managers.set(manager, owner);
    }
    return owner;
  }

  async createProvider(
    manager: T,
    adapter: MemoryEmbeddingProviderAdapter,
    create: ProviderFactory,
  ) {
    const owner = this.managers.get(manager);
    if (!owner) {
      throw new Error("Memory manager has no lifecycle owner");
    }
    if (owner.retiring || this.reload?.retireRuntime || this.reload?.adapters.has(adapter)) {
      throw new MemoryManagerReloadError();
    }
    const acquisition = {};
    // Record the exact adapter before creation can yield; late results belong to
    // this manager's close, including when replacement began during creation.
    owner.pending.set(acquisition, adapter);
    try {
      const result = await create();
      if (result.provider) {
        owner.providers.set(result.provider, adapter);
        owner.failedAdapters.delete(adapter);
      } else {
        owner.failedAdapters.add(adapter);
      }
      return result;
    } catch (error) {
      owner.failedAdapters.add(adapter);
      throw error;
    } finally {
      owner.pending.delete(acquisition);
    }
  }

  canPublishProbe(manager: T): boolean {
    const owner = this.managers.get(manager);
    return owner !== undefined && !owner.retiring;
  }

  getProbeOwners(manager: T): readonly MemoryEmbeddingProviderAdapter[] {
    const owner = this.managers.get(manager);
    return owner
      ? [
          ...new Set([
            ...owner.pending.values(),
            ...owner.providers.values(),
            ...owner.failedAdapters,
          ]),
        ]
      : [];
  }

  releaseProvider(manager: T, provider: MemoryEmbeddingProvider): void {
    this.managers.get(manager)?.providers.delete(provider);
  }

  prepareReload(
    change: MemoryReloadChange,
  ): ReturnType<NonNullable<MemoryPluginRuntime["prepareReload"]>> {
    return prepareMemoryManagerReload(change, this.lifecycle);
  }

  private prepareManagersForReload(reload: MemoryReloadState) {
    // A probe can outlive its transient manager, but never the adapter that produced it.
    for (const [key, entry] of this.embeddingProbeCache) {
      if (reload.retireRuntime || entry.adapters.some((adapter) => reload.adapters.has(adapter))) {
        this.embeddingProbeCache.delete(key);
      }
    }
    return async () => {
      // Overlapping reloads join the manager's existing close; retirement alone
      // does not mean its cleanup has completed.
      const selected = [...this.managers].filter(
        ([, owner]) =>
          owner.retiring ||
          reload.retireRuntime ||
          [...owner.pending.values(), ...owner.providers.values(), ...owner.failedAdapters].some(
            (adapter) => reload.adapters.has(adapter),
          ),
      );
      for (const [manager, owner] of selected) {
        owner.retiring = true;
        // Release reuse before cleanup can yield. Keep the retiring owner so
        // late provider/probe work cannot publish into its replacement's cache.
        if (this.cache.get(owner.key) === manager) {
          this.cache.delete(owner.key);
        }
        this.embeddingProbeCache.delete(owner.key);
      }
      // Capture construction tails with this retirement; a timeout followed by
      // resume must not make this old drain select newly acquired managers.
      const results = await Promise.allSettled([
        ...(reload.retireRuntime ? this.scopeOperations.values() : []),
        ...selected.map(([manager, owner]) => this.closeEntry(owner.key, manager)),
      ]);
      return {
        errors: results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      };
    };
  }

  async acquire(
    params: { agentId: string; purpose: MemoryIndexManagerPurpose },
    callbacks: MemoryManagerRegistryCallbacks<T>,
  ): Promise<T | null> {
    // A detached search handoff may race global teardown. Decline late
    // maintenance acquisition so closing the default manager cannot wait on itself.
    if (
      params.purpose === "maintenance" &&
      (this.reload?.retireRuntime || this.closePromise || this.closeFailed)
    ) {
      return null;
    }
    if (this.reload?.retireRuntime) {
      throw new MemoryManagerReloadError();
    }
    return await this.runScopeOperation(params, async () => {
      if (this.reload?.retireRuntime) {
        throw new MemoryManagerReloadError();
      }
      if (this.closeFailed) {
        await this.retryFailedGlobalClose();
      }
      const prepared = await callbacks.prepare();
      if (!prepared) {
        return null;
      }
      if (this.reload?.retireRuntime) {
        throw new MemoryManagerReloadError();
      }
      const transient = isTransientMemoryIndexManagerPurpose(params.purpose);
      const create = async () => {
        if (this.reload?.retireRuntime) {
          throw new MemoryManagerReloadError();
        }
        const manager = await prepared.create();
        const owner = this.track(manager, prepared.key);
        if (this.reload?.retireRuntime) {
          owner.retiring = true;
          await this.closeEntries([[prepared.key, manager]]);
          throw new MemoryManagerReloadError();
        }
        return manager;
      };
      if (transient) {
        return await create();
      }
      const cachedManager = this.cache.get(prepared.key);
      await this.closeScopeUnlocked({
        agentId: params.agentId,
        purpose: params.purpose,
        ...(cachedManager && prepared.reuse(cachedManager) ? { exceptKey: prepared.key } : {}),
      });
      // The scope queue already serializes creation and replacement for this agent.
      const existing = this.cache.get(prepared.key);
      if (existing) {
        // Other sidecars may drain between preparation and memory cleanup.
        // Recheck after the scope await without discarding the manager needed for rollback.
        const reload = this.reload;
        if (
          reload &&
          (reload.retireRuntime ||
            this.getProbeOwners(existing).some((adapter) => reload.adapters.has(adapter)))
        ) {
          throw new MemoryManagerReloadError();
        }
        return existing;
      }
      const manager = await create();
      this.cache.set(prepared.key, manager);
      return manager;
    });
  }

  async closeAll(): Promise<void> {
    await this.runGlobalClose(() => this.retryFailedGlobalClose());
  }

  async closeForAgent(params: {
    agentId: string;
    purpose: MemoryIndexManagerPurpose;
  }): Promise<void> {
    const scope = { agentId: normalizeAgentId(params.agentId), purpose: params.purpose };
    await this.runScopeOperation(scope, async () => {
      await this.closeScopeUnlocked(scope);
    });
  }

  deleteIfCurrent(key: string, manager: T): void {
    this.managers.delete(manager);
    if (this.cache.get(key) === manager) {
      this.cache.delete(key);
    }
  }

  private async retryFailedGlobalClose(): Promise<void> {
    try {
      await this.closeAllUnlocked();
      this.closeFailed = false;
    } catch (err) {
      this.closeFailed = true;
      throw err;
    }
  }

  private async runGlobalClose(operation: () => Promise<void>): Promise<void> {
    const previous = this.closePromise ?? Promise.resolve();
    const closePromise = previous.then(operation, operation);
    this.closePromise = closePromise;
    await closePromise;
    if (this.closePromise === closePromise) {
      this.closePromise = null;
    }
  }

  private async runScopeOperation<R>(
    params: { agentId: string; purpose: MemoryIndexManagerPurpose },
    operation: () => Promise<R>,
  ): Promise<R> {
    while (this.closePromise) {
      const globalClose = this.closePromise;
      try {
        await globalClose;
      } catch {
        if (this.closePromise === globalClose) {
          await this.closeAll();
        }
      }
    }
    const scopeKey = JSON.stringify([params.agentId, params.purpose]);
    const previousOperation = this.scopeOperations.get(scopeKey) ?? Promise.resolve();
    const result = previousOperation.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.scopeOperations.set(scopeKey, tail);
    try {
      return await result;
    } finally {
      if (this.scopeOperations.get(scopeKey) === tail) {
        this.scopeOperations.delete(scopeKey);
      }
    }
  }

  private async closeAllUnlocked(): Promise<void> {
    const scopedOperations = Array.from(this.scopeOperations.values());
    if (scopedOperations.length > 0) {
      await Promise.allSettled(scopedOperations);
    }
    // Withdrawn retirement owners still need explicit retry; live transient managers remain caller-owned.
    await this.closeEntries(
      [...this.managers]
        .filter(([manager, owner]) => owner.retiring || this.cache.get(owner.key) === manager)
        .map(([manager, owner]) => [owner.key, manager]),
    );
  }

  private async closeScopeUnlocked(params: {
    agentId: string;
    purpose: MemoryIndexManagerPurpose;
    exceptKey?: string;
  }): Promise<void> {
    const isScopedKey = (key: string) =>
      key !== params.exceptKey &&
      key.startsWith(`${params.agentId}:`) &&
      key.endsWith(`:${params.purpose}`);
    await this.closeEntries(
      Array.from(this.cache.entries()).filter(([key]) => isScopedKey(key)),
      params.agentId,
    );
  }

  private async closeEntry(key: string, manager: T): Promise<void> {
    await manager.close();
    this.deleteIfCurrent(key, manager);
  }

  private async closeEntries(entries: Array<[string, T]>, agentId?: string): Promise<void> {
    let firstError: unknown;
    for (const [key, manager] of entries) {
      try {
        await this.closeEntry(key, manager);
      } catch (err) {
        firstError ??= err;
        const scope = agentId ? ` for agent ${agentId}` : "";
        log.warn(`failed to close memory index manager${scope}: ${String(err)}`);
      }
    }
    if (firstError !== undefined) {
      throw toErrorObject(firstError, "Failed to close memory index manager");
    }
  }
}
