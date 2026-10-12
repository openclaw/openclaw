// Memory Core plugin module owns manager cache and close serialization.
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { enqueueKeyedTask } from "openclaw/plugin-sdk/keyed-async-queue";
import type {
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemoryEmbeddingProbeResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  resolveMemoryCoreLocalServiceHostIdentity,
  type MemoryCoreAcquireLocalService,
} from "./embedding-local-service.js";
import {
  MemoryManagerReloadError,
  type MemoryManagerLifecycle,
  type MemoryReloadState,
} from "./lifecycle.js";

const log = createSubsystemLogger("memory");

export type MemoryIndexManagerPurpose = "default" | "status" | "cli" | "maintenance";

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
  adapters: Set<MemoryEmbeddingProviderAdapter>;
  retiring: boolean;
};

export class MemoryManagerRegistry<T extends ClosableMemoryManager> {
  readonly embeddingProbeCache = new Map<string, MemoryEmbeddingProbeCacheEntry>();
  private readonly cache = new Map<string, T>();
  private readonly scopeOperations = new Map<string, Promise<void>>();
  private closePromise: Promise<void> | null = null;
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
        adapters: new Set(),
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
    // Remember attempted adapters, including a primary that fell back.
    owner.adapters.add(adapter);
    return await create();
  }

  canPublishProbe(manager: T): boolean {
    const owner = this.managers.get(manager);
    return owner !== undefined && !owner.retiring;
  }

  getProbeOwners(manager: T): readonly MemoryEmbeddingProviderAdapter[] {
    const owner = this.managers.get(manager);
    return owner ? [...owner.adapters] : [];
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
        ([manager, owner]) =>
          owner.retiring ||
          reload.retireRuntime ||
          this.getProbeOwners(manager).some((adapter) => reload.adapters.has(adapter)),
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
    if (params.purpose === "maintenance" && (this.reload?.retireRuntime || this.closePromise)) {
      return null;
    }
    if (this.reload?.retireRuntime) {
      throw new MemoryManagerReloadError();
    }
    return await this.runScopeOperation(params, async () => {
      const prepared = await callbacks.prepare();
      if (!prepared) {
        return null;
      }
      const create = async () => {
        const manager = await prepared.create();
        this.track(manager, prepared.key);
        return manager;
      };
      if (params.purpose !== "default") {
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
        return existing;
      }
      const manager = await create();
      this.cache.set(prepared.key, manager);
      return manager;
    });
  }

  async closeAll(): Promise<void> {
    const previous = this.closePromise ?? Promise.resolve();
    const operation = () => this.closeAllUnlocked();
    const closePromise = previous.then(operation, operation);
    this.closePromise = closePromise;
    await closePromise;
    if (this.closePromise === closePromise) {
      this.closePromise = null;
    }
  }

  async closeForAgent(params: {
    agentId: string;
    purpose: MemoryIndexManagerPurpose;
  }): Promise<void> {
    const scope = { agentId: normalizeAgentId(params.agentId), purpose: params.purpose };
    await this.runScopeOperation(scope, () => this.closeScopeUnlocked(scope));
  }

  deleteIfCurrent(key: string, manager: T): void {
    this.managers.delete(manager);
    if (this.cache.get(key) === manager) {
      this.cache.delete(key);
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
    return await enqueueKeyedTask({
      tails: this.scopeOperations,
      key: JSON.stringify([params.agentId, params.purpose]),
      task: operation,
    });
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
