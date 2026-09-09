// Memory Core plugin module owns manager cache and close serialization.
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveGlobalSingleton,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  resolveMemoryCoreLocalServiceHostIdentity,
  type MemoryCoreAcquireLocalService,
} from "./embedding-local-service.js";

const MEMORY_INDEX_MANAGER_CACHE_KEY = Symbol.for("openclaw.memoryIndexManagers");
const MEMORY_INDEX_MANAGER_SCOPE_CLOSES_KEY = Symbol.for("openclaw.memoryIndexManagerScopeCloses");
const MEMORY_INDEX_MANAGER_GLOBAL_LIFECYCLE_KEY = Symbol.for(
  "openclaw.memoryIndexManagerGlobalLifecycle.v3",
);
const MEMORY_INDEX_MANAGER_PENDING_CLEANUP_KEY = Symbol.for(
  "openclaw.memoryIndexManagerPendingCleanup.v2",
);
const log = createSubsystemLogger("memory");

export type MemoryIndexManagerPurpose = "default" | "status" | "cli" | "search" | "maintenance";

function isTransientMemoryIndexManagerPurpose(purpose: MemoryIndexManagerPurpose): boolean {
  return purpose !== "default" && purpose !== "search";
}

export function normalizeMemoryIndexManagerPurpose(
  purpose: MemoryIndexManagerPurpose | undefined,
): MemoryIndexManagerPurpose {
  return purpose === "status" ||
    purpose === "cli" ||
    purpose === "search" ||
    purpose === "maintenance"
    ? purpose
    : "default";
}

type ClosableMemoryManager = {
  close(): Promise<void>;
};

type PreparedMemoryManager<T extends ClosableMemoryManager> = {
  key: string;
  create: () => Promise<T> | T;
  reuse: (manager: T) => Promise<boolean> | boolean;
};

type MemoryManagerRegistryCallbacks<T extends ClosableMemoryManager> = {
  prepare: () => Promise<PreparedMemoryManager<T> | null> | PreparedMemoryManager<T> | null;
};

type MemoryManagerRegistryGlobalLifecycle = {
  closePromise: Promise<void> | null;
  closeFailed: boolean;
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

export class MemoryManagerRegistry<T extends ClosableMemoryManager> {
  private readonly cache: Map<string, T>;
  private readonly scopeOperations: Map<string, Promise<void>>;
  private readonly globalLifecycle: MemoryManagerRegistryGlobalLifecycle;
  private readonly pendingCleanup: Map<T, { agentId: string; purpose: MemoryIndexManagerPurpose }>;

  constructor() {
    this.cache = resolveGlobalSingleton(MEMORY_INDEX_MANAGER_CACHE_KEY, () => new Map<string, T>());
    this.scopeOperations = resolveGlobalSingleton<Map<string, Promise<void>>>(
      MEMORY_INDEX_MANAGER_SCOPE_CLOSES_KEY,
      () => new Map(),
    );
    this.globalLifecycle = resolveGlobalSingleton<MemoryManagerRegistryGlobalLifecycle>(
      MEMORY_INDEX_MANAGER_GLOBAL_LIFECYCLE_KEY,
      () => ({ closePromise: null, closeFailed: false }),
    );
    this.pendingCleanup = resolveGlobalSingleton<
      Map<T, { agentId: string; purpose: MemoryIndexManagerPurpose }>
    >(MEMORY_INDEX_MANAGER_PENDING_CLEANUP_KEY, () => new Map());
  }

  async acquire(
    params: { agentId: string; purpose: MemoryIndexManagerPurpose },
    callbacks: MemoryManagerRegistryCallbacks<T>,
  ): Promise<T | null> {
    // A detached search handoff may race global teardown. Decline late
    // maintenance acquisition so closing the default manager cannot wait on itself.
    if (
      params.purpose === "maintenance" &&
      (this.globalLifecycle.closePromise || this.globalLifecycle.closeFailed)
    ) {
      return null;
    }
    return await this.runScopeOperation(params, async () => {
      if (this.globalLifecycle.closeFailed) {
        await this.retryFailedGlobalClose();
      }
      const prepared = await callbacks.prepare();
      if (!prepared) {
        return null;
      }
      const transient = isTransientMemoryIndexManagerPurpose(params.purpose);
      if (transient) {
        return await prepared.create();
      }
      const cachedManager = this.cache.get(prepared.key);
      if (cachedManager && (await prepared.reuse(cachedManager))) {
        await this.closeScopeUnlocked({
          agentId: params.agentId,
          purpose: params.purpose,
          exceptKey: prepared.key,
        });
        return cachedManager;
      }

      if (params.purpose !== "search") {
        await this.closeScopeUnlocked({
          agentId: params.agentId,
          purpose: params.purpose,
        });
        const existing = this.cache.get(prepared.key);
        if (existing) {
          return existing;
        }
        const manager = await prepared.create();
        this.cache.set(prepared.key, manager);
        return manager;
      }

      // Build a replacement before retiring the current reader. A failed
      // reader acquisition must not create an avoidable search availability gap.
      const candidate = await prepared.create();
      try {
        await this.closeScopeUnlocked({
          agentId: params.agentId,
          purpose: params.purpose,
        });
      } catch (err) {
        try {
          await candidate.close();
        } catch (cleanupError) {
          this.retainForCleanup(candidate, params);
          throw new Error(
            `Memory manager replacement failed: ${String(err)}; candidate cleanup also failed`,
            { cause: cleanupError },
          );
        }
        throw err;
      }
      this.cache.set(prepared.key, candidate);
      return candidate;
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
      const errors: unknown[] = [];
      try {
        await this.closeScopeUnlocked(scope);
      } catch (err) {
        errors.push(err);
      }
      try {
        await this.closePendingCleanup(scope);
      } catch (err) {
        errors.push(err);
      }
      if (errors.length > 0) {
        throw errors.length === 1
          ? errors[0]
          : new AggregateError(errors, "Failed to close scoped memory index managers");
      }
    });
  }

  deleteIfCurrent(key: string, manager: T): void {
    if (this.cache.get(key) === manager) {
      this.cache.delete(key);
    }
  }

  retainForCleanup(
    manager: T,
    scope: { agentId: string; purpose: MemoryIndexManagerPurpose },
  ): void {
    this.pendingCleanup.set(manager, {
      agentId: normalizeAgentId(scope.agentId),
      purpose: scope.purpose,
    });
  }

  private async retryFailedGlobalClose(): Promise<void> {
    try {
      await this.closeAllUnlocked();
      this.globalLifecycle.closeFailed = false;
    } catch (err) {
      this.globalLifecycle.closeFailed = true;
      throw err;
    }
  }

  private async runGlobalClose(operation: () => Promise<void>): Promise<void> {
    const previous = this.globalLifecycle.closePromise ?? Promise.resolve();
    const closePromise = previous.then(operation, operation);
    this.globalLifecycle.closePromise = closePromise;
    await closePromise;
    if (this.globalLifecycle.closePromise === closePromise) {
      this.globalLifecycle.closePromise = null;
    }
  }

  private async runScopeOperation<R>(
    params: { agentId: string; purpose: MemoryIndexManagerPurpose },
    operation: () => Promise<R>,
  ): Promise<R> {
    while (this.globalLifecycle.closePromise) {
      const globalClose = this.globalLifecycle.closePromise;
      try {
        await globalClose;
      } catch {
        if (this.globalLifecycle.closePromise === globalClose) {
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
    const errors: unknown[] = [];
    try {
      await this.closeEntries(Array.from(this.cache.entries()));
    } catch (err) {
      errors.push(err);
    }
    try {
      await this.closePendingCleanup();
    } catch (err) {
      errors.push(err);
    }
    if (errors.length > 0) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "Failed to close memory index managers");
    }
  }

  private async closePendingCleanup(scope?: {
    agentId: string;
    purpose: MemoryIndexManagerPurpose;
  }): Promise<void> {
    let firstError: unknown;
    for (const [manager, retainedScope] of this.pendingCleanup) {
      if (
        scope &&
        (retainedScope.agentId !== scope.agentId || retainedScope.purpose !== scope.purpose)
      ) {
        continue;
      }
      try {
        await manager.close();
        this.pendingCleanup.delete(manager);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError !== undefined) {
      throw toErrorObject(firstError, "Failed to close retained memory index manager");
    }
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

  private async closeEntries(entries: Array<[string, T]>, agentId?: string): Promise<void> {
    let firstError: unknown;
    for (const [key, manager] of entries) {
      try {
        await manager.close();
        this.deleteIfCurrent(key, manager);
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
