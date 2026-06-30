import { createHash } from "node:crypto";
// Memory Core plugin module implements search manager behavior.
import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveAgentContextLimits,
  resolveAgentWorkspaceDir,
  resolveGlobalSingleton,
  resolveMemorySearchSyncConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  checkQmdBinaryAvailability,
  resolveQmdBinaryUnavailableReason,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  resolveMemoryBackendConfig,
  type MemoryEmbeddingProbeResult,
  type MemorySearchManager,
  type MemorySearchRuntimeDebug,
  type MemorySource,
  type MemorySyncParams,
  type ResolvedHybridConfig,
  type ResolvedMem0Config,
  type ResolvedQmdConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";

const MEMORY_SEARCH_MANAGER_CACHE_KEY = Symbol.for("openclaw.memorySearchManagerCache");
type Maybe<T> = T | null;
type QmdManagerRuntimeConfig = {
  workspaceDir: string;
  syncSettings: ReturnType<typeof resolveMemorySearchSyncConfig>;
  contextLimits: ReturnType<typeof resolveAgentContextLimits>;
};

type CachedQmdManagerEntry = {
  identityKey: string;
  manager: MemorySearchManager;
};

type PendingQmdManagerCreate = {
  identityKey: string;
  promise: Promise<Maybe<MemorySearchManager>>;
};

type QmdManagerOpenFailure = {
  identityKey: string;
  reason: string;
  retryAfterMs: number;
};

type MemorySearchManagerCacheState =
  | "cached-full-hit"
  | "cached-full-miss"
  | "transient-cli"
  | "transient-status"
  | "pending-create-wait"
  | "fallback-builtin"
  | "recent-failure-cooldown";

const QMD_MANAGER_OPEN_FAILURE_COOLDOWN_MS = 60_000;

export type MemorySearchManagerDebug = {
  backend?: "builtin" | "qmd" | "mem0" | "hybrid";
  purpose?: MemorySearchManagerPurpose;
  managerMs?: number;
  managerCacheState?: MemorySearchManagerCacheState;
  qmdIdentityHash?: string;
  failureCode?: "qmd-unavailable";
};

type MemorySearchManagerCacheStore = {
  qmdManagerCache: Map<string, CachedQmdManagerEntry>;
  pendingQmdManagerCreates: Map<string, PendingQmdManagerCreate>;
  qmdManagerOpenFailures: Map<string, QmdManagerOpenFailure>;
  mem0ManagerCache: Map<string, MemorySearchManager>;
  hybridManagerCache: Map<string, MemorySearchManager>;
};

function getMemorySearchManagerCacheStore(): MemorySearchManagerCacheStore {
  // Keep caches reachable across `vi.resetModules()` so later cleanup can close older instances.
  const resolved = resolveGlobalSingleton<unknown>(
    MEMORY_SEARCH_MANAGER_CACHE_KEY,
    () => ({
      qmdManagerCache: new Map<string, CachedQmdManagerEntry>(),
      pendingQmdManagerCreates: new Map<string, PendingQmdManagerCreate>(),
      qmdManagerOpenFailures: new Map<string, QmdManagerOpenFailure>(),
      mem0ManagerCache: new Map<string, MemorySearchManager>(),
      hybridManagerCache: new Map<string, MemorySearchManager>(),
    }),
  );
  if (typeof resolved !== "object" || resolved === null) {
    const repaired = {
      qmdManagerCache: new Map<string, CachedQmdManagerEntry>(),
      pendingQmdManagerCreates: new Map<string, PendingQmdManagerCreate>(),
      qmdManagerOpenFailures: new Map<string, QmdManagerOpenFailure>(),
      mem0ManagerCache: new Map<string, MemorySearchManager>(),
      hybridManagerCache: new Map<string, MemorySearchManager>(),
    };
    (globalThis as Record<PropertyKey, unknown>)[MEMORY_SEARCH_MANAGER_CACHE_KEY] = repaired;
    return repaired;
  }
  const cacheStore = resolved as Partial<MemorySearchManagerCacheStore>;
  cacheStore.qmdManagerCache ??= new Map<string, CachedQmdManagerEntry>();
  cacheStore.pendingQmdManagerCreates ??= new Map<string, PendingQmdManagerCreate>();
  cacheStore.qmdManagerOpenFailures ??= new Map<string, QmdManagerOpenFailure>();
  cacheStore.mem0ManagerCache ??= new Map<string, MemorySearchManager>();
  cacheStore.hybridManagerCache ??= new Map<string, MemorySearchManager>();
  return cacheStore as MemorySearchManagerCacheStore;
}

const log = createSubsystemLogger("memory");
const {
  qmdManagerCache: QMD_MANAGER_CACHE,
  pendingQmdManagerCreates: PENDING_QMD_MANAGER_CREATES,
  qmdManagerOpenFailures: QMD_MANAGER_OPEN_FAILURES,
  mem0ManagerCache: MEM0_MANAGER_CACHE,
  hybridManagerCache: HYBRID_MANAGER_CACHE,
} = getMemorySearchManagerCacheStore();
let managerRuntimePromise: Promise<typeof import("../../manager-runtime.js")> | null = null;
let qmdManagerModulePromise: Promise<typeof import("./qmd-manager.js")> | null = null;

function loadManagerRuntime() {
  managerRuntimePromise ??= import("../../manager-runtime.js");
  return managerRuntimePromise;
}

function loadQmdManagerModule() {
  qmdManagerModulePromise ??= import("./qmd-manager.js");
  return qmdManagerModulePromise;
}

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
  debug?: MemorySearchManagerDebug;
};

export type MemorySearchManagerPurpose = "cli" | "default" | "status";

function getActiveQmdManagerOpenFailure(
  scopeKey: string,
  identityKey: string,
  nowMs = Date.now(),
): QmdManagerOpenFailure | null {
  const failure = QMD_MANAGER_OPEN_FAILURES.get(scopeKey);
  if (!failure) {
    return null;
  }
  if (failure.identityKey !== identityKey || failure.retryAfterMs <= nowMs) {
    QMD_MANAGER_OPEN_FAILURES.delete(scopeKey);
    return null;
  }
  return failure;
}

function recordQmdManagerOpenFailure(
  scopeKey: string,
  identityKey: string,
  reason: string,
  nowMs = Date.now(),
): void {
  QMD_MANAGER_OPEN_FAILURES.set(scopeKey, {
    identityKey,
    reason,
    retryAfterMs: nowMs + QMD_MANAGER_OPEN_FAILURE_COOLDOWN_MS,
  });
}

function clearQmdManagerOpenFailure(scopeKey: string, identityKey: string): void {
  const failure = QMD_MANAGER_OPEN_FAILURES.get(scopeKey);
  if (failure?.identityKey === identityKey) {
    QMD_MANAGER_OPEN_FAILURES.delete(scopeKey);
  }
}

async function getOrCreateMem0Manager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  resolvedMem0?: ResolvedMem0Config;
}): Promise<MemorySearchManager | null> {
  if (!params.resolvedMem0?.enabled) {
    return null;
  }
  const cacheKey = `${params.agentId}:${JSON.stringify(params.resolvedMem0)}`;
  const cached = MEM0_MANAGER_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }
  try {
    const { Mem0MemoryManager } = await import("./mem0-manager.js");
    const manager = await Mem0MemoryManager.create({
      cfg: params.cfg,
      agentId: params.agentId,
      resolved: params.resolvedMem0,
    });
    if (manager) {
      MEM0_MANAGER_CACHE.set(cacheKey, manager);
      return manager;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`mem0 memory unavailable; falling back to builtin: ${message}`);
  }
  return null;
}

function buildHybridCacheKey(params: {
  agentId: string;
  qmd?: ResolvedQmdConfig;
  mem0?: unknown;
  hybrid?: ResolvedHybridConfig;
  purpose?: MemorySearchManagerPurpose;
}): string {
  return `${params.agentId}:${params.purpose ?? "default"}:${JSON.stringify({
    qmd: params.qmd,
    mem0: params.mem0,
    hybrid: params.hybrid,
  })}`;
}

function hashQmdManagerIdentity(identityKey: string): string {
  return createHash("sha256").update(identityKey).digest("hex");
}

function applyManagerDebug(
  result: MemorySearchManagerResult,
  debug: MemorySearchManagerDebug,
): MemorySearchManagerResult {
  if (result.debug && Object.keys(result.debug).length > 0 && Object.keys(debug).length === 0) {
    return result;
  }
  return {
    ...result,
    debug: {
      ...result.debug,
      ...debug,
    },
  };
}

export async function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemorySearchManagerPurpose;
}): Promise<MemorySearchManagerResult> {
  const acquireStartedAt = Date.now();
  const purpose = params.purpose ?? "default";
  const finish = (
    result: MemorySearchManagerResult,
    debug: MemorySearchManagerDebug,
  ): MemorySearchManagerResult =>
    applyManagerDebug(result, {
      purpose,
      managerMs: Math.max(0, Date.now() - acquireStartedAt),
      ...debug,
    });
  const resolved = resolveMemoryBackendConfig(params);
  if (resolved.backend === "mem0") {
    const manager = await getOrCreateMem0Manager({
      cfg: params.cfg,
      agentId: params.agentId,
      resolvedMem0: resolved.mem0,
    });
    if (manager) {
      return finish({ manager }, { backend: "mem0" });
    }
  }
  if (resolved.backend === "hybrid") {
    const cacheKey = buildHybridCacheKey({
      agentId: params.agentId,
      qmd: resolved.qmd,
      mem0: resolved.mem0,
      hybrid: resolved.hybrid,
      purpose: params.purpose,
    });
    const cached = HYBRID_MANAGER_CACHE.get(cacheKey);
    if (cached) {
      return finish({ manager: cached }, { backend: "hybrid" });
    }
    const [qmdManager, mem0Manager] = await Promise.all([
      resolved.qmd
        ? getMemorySearchManager({
            cfg: { ...params.cfg, memory: { ...params.cfg.memory, backend: "qmd" } },
            agentId: params.agentId,
            purpose: params.purpose,
          }).then((result) => result.manager)
        : Promise.resolve(null),
      getOrCreateMem0Manager({
        cfg: params.cfg,
        agentId: params.agentId,
        resolvedMem0: resolved.mem0,
      }),
    ]);
    if (qmdManager || mem0Manager) {
      const { MemoryIndexManager } = await loadManagerRuntime();
      const fallback = await MemoryIndexManager.get(params);
      const { HybridMemoryManager } = await import("./hybrid-manager.js");
      const manager = new HybridMemoryManager({
        config: resolved.hybrid ?? {
          readMode: "routed",
          writeMode: "routed",
          successPolicy: "any",
          readOrder: ["mem0", "qmd"],
          maxResults: 8,
          dedupe: true,
          routing: [],
        },
        qmd: qmdManager,
        mem0: mem0Manager as MemorySearchManager & {
          captureConversation?: (params: {
            sessionKey?: string;
            messages: unknown[];
          }) => Promise<void>;
        },
        fallback,
      });
      HYBRID_MANAGER_CACHE.set(cacheKey, manager);
      return finish({ manager }, { backend: "hybrid" });
    }
  }
  if (resolved.backend === "qmd" && resolved.qmd) {
    const qmdResolved = resolved.qmd;
    const normalizedAgentId = normalizeAgentId(params.agentId);
    const runtimeConfig = resolveQmdManagerRuntimeConfig(params.cfg, normalizedAgentId);
    const { workspaceDir } = runtimeConfig;
    const transient = params.purpose === "status" || params.purpose === "cli";
    const scopeKey = buildQmdManagerScopeKey(normalizedAgentId);
    const identityKey = buildQmdManagerIdentityKey(normalizedAgentId, qmdResolved, runtimeConfig);
    const debugIdentityHash = hashQmdManagerIdentity(identityKey);

    const createPrimaryQmdManager = async (
      mode: "full" | "status" | "cli",
    ): Promise<{ manager: Maybe<MemorySearchManager>; failureReason?: string }> => {
      try {
        await fs.mkdir(workspaceDir, { recursive: true });
      } catch (err) {
        const message = formatErrorMessage(err);
        log.warn(
          `qmd workspace unavailable (${workspaceDir}); falling back to builtin: ${message}`,
        );
        return {
          manager: null,
          failureReason: `qmd workspace unavailable (${workspaceDir}): ${message}`,
        };
      }

      const qmdBinary = await checkQmdBinaryAvailability({
        command: qmdResolved.command,
        env: process.env,
        cwd: workspaceDir,
      });
      if (!qmdBinary.available) {
        const message = qmdBinary.error;
        const failurePrefix =
          resolveQmdBinaryUnavailableReason(qmdBinary) === "workspace-cwd"
            ? `qmd workspace unavailable (${workspaceDir})`
            : `qmd binary unavailable (${qmdResolved.command})`;
        log.warn(`${failurePrefix}; falling back to builtin: ${message}`);
        return {
          manager: null,
          failureReason: `${failurePrefix}: ${message}`,
        };
      }
      try {
        const { QmdMemoryManager } = await loadQmdManagerModule();
        const primary = await QmdMemoryManager.create({
          cfg: params.cfg,
          agentId: normalizedAgentId,
          resolved: { ...resolved, qmd: qmdResolved },
          mode,
          runtimeConfig,
        });
        if (primary) {
          clearQmdManagerOpenFailure(scopeKey, identityKey);
          return { manager: primary };
        }
      } catch (err) {
        const message = formatErrorMessage(err);
        log.warn(`qmd memory unavailable; falling back to builtin: ${message}`);
        return { manager: null, failureReason: `qmd memory unavailable: ${message}` };
      }
      return { manager: null, failureReason: "qmd memory unavailable: no manager returned" };
    };

    const createFullQmdManager = async (
      expectedIdentityKey: string,
    ): Promise<{ entry: Maybe<CachedQmdManagerEntry>; failureReason?: string }> => {
      const { manager: primary, failureReason } = await createPrimaryQmdManager("full");
      if (!primary) {
        return { entry: null, failureReason };
      }
      const wrapper = new FallbackMemoryManager(
        {
          primary,
          fallbackFactory: async () => {
            const { MemoryIndexManager } = await loadManagerRuntime();
            return await MemoryIndexManager.get(params);
          },
        },
        () => {
          const current = QMD_MANAGER_CACHE.get(scopeKey);
          if (current === cacheEntry) {
            QMD_MANAGER_CACHE.delete(scopeKey);
          }
        },
      );
      const cacheEntry: CachedQmdManagerEntry = {
        identityKey: expectedIdentityKey,
        manager: wrapper,
      };
      return { entry: cacheEntry };
    };

    const cached = QMD_MANAGER_CACHE.get(scopeKey);
    const cachedMatchesIdentity = cached?.identityKey === identityKey;
    if (cachedMatchesIdentity) {
      if (params.purpose === "status") {
        // Status callers often close the manager they receive. Wrap the live
        // full manager with a no-op close so health/status probes do not tear
        // down the active QMD manager for the process.
        return finish(
          { manager: new BorrowedMemoryManager(cached.manager) },
          {
            backend: "qmd",
            managerCacheState: "cached-full-hit",
            qmdIdentityHash: debugIdentityHash,
          },
        );
      }
      if (params.purpose !== "cli") {
        return finish(
          { manager: cached.manager },
          {
            backend: "qmd",
            managerCacheState: "cached-full-hit",
            qmdIdentityHash: debugIdentityHash,
          },
        );
      }
    }

    if (transient) {
      const { manager, failureReason } = await createPrimaryQmdManager(
        params.purpose === "cli" ? "cli" : "status",
      );
      return manager
        ? finish(
            { manager },
            {
              backend: "qmd",
              managerCacheState: params.purpose === "cli" ? "transient-cli" : "transient-status",
              qmdIdentityHash: debugIdentityHash,
            },
          )
        : finish(await getBuiltinMemorySearchManagerAfterQmdFailure(params, failureReason), {
            backend: "qmd",
            managerCacheState: "fallback-builtin",
            qmdIdentityHash: debugIdentityHash,
            failureCode: "qmd-unavailable",
          });
    }

    const recentFailure = getActiveQmdManagerOpenFailure(scopeKey, identityKey);
    if (recentFailure) {
      log.debug?.(`qmd memory unavailable; using builtin during cooldown: ${recentFailure.reason}`);
      return finish(
        await getBuiltinMemorySearchManagerAfterQmdFailure(params, recentFailure.reason),
        {
          backend: "qmd",
          managerCacheState: "recent-failure-cooldown",
          qmdIdentityHash: debugIdentityHash,
          failureCode: "qmd-unavailable",
        },
      );
    }

    const pending = PENDING_QMD_MANAGER_CREATES.get(scopeKey);
    if (pending) {
      await pending.promise;
      return finish(await getMemorySearchManager(params), {
        backend: "qmd",
        managerCacheState: "pending-create-wait",
        qmdIdentityHash: debugIdentityHash,
      });
    }

    let pendingFailureReason: string | undefined;
    const pendingCreate: PendingQmdManagerCreate = {
      identityKey,
      promise: (async () => {
        const created = await createFullQmdManager(identityKey);
        if (!created.entry) {
          pendingFailureReason = created.failureReason ?? "qmd memory unavailable";
          recordQmdManagerOpenFailure(scopeKey, identityKey, pendingFailureReason);
          return null;
        }
        QMD_MANAGER_CACHE.set(scopeKey, created.entry);
        if (cached) {
          await closeQmdManagerForReplacement(cached.manager).catch((err: unknown) => {
            log.warn(`failed to retire replaced qmd memory manager: ${formatErrorMessage(err)}`);
          });
        }
        return created.entry.manager;
      })().finally(() => {
        const currentPending = PENDING_QMD_MANAGER_CREATES.get(scopeKey);
        if (currentPending === pendingCreate) {
          PENDING_QMD_MANAGER_CREATES.delete(scopeKey);
        }
      }),
    };
    PENDING_QMD_MANAGER_CREATES.set(scopeKey, pendingCreate);
    const manager = await pendingCreate.promise;
    return manager
      ? finish(
          { manager },
          {
            backend: "qmd",
            managerCacheState: "cached-full-miss",
            qmdIdentityHash: debugIdentityHash,
          },
        )
      : finish(await getBuiltinMemorySearchManagerAfterQmdFailure(params, pendingFailureReason), {
          backend: "qmd",
          managerCacheState: "fallback-builtin",
          qmdIdentityHash: debugIdentityHash,
          failureCode: "qmd-unavailable",
        });
  }

  return finish(await getBuiltinMemorySearchManager(params), {
    backend: "builtin",
  });
}

async function getBuiltinMemorySearchManagerAfterQmdFailure(
  params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: MemorySearchManagerPurpose;
  },
  qmdFailureReason: string | undefined,
): Promise<MemorySearchManagerResult> {
  const fallback = await getBuiltinMemorySearchManager(params);
  if (fallback.manager || !qmdFailureReason) {
    return fallback;
  }
  const fallbackError = fallback.error?.trim();
  return {
    manager: null,
    error: fallbackError
      ? `${qmdFailureReason}; builtin fallback unavailable: ${fallbackError}`
      : qmdFailureReason,
  };
}

async function getBuiltinMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemorySearchManagerPurpose;
}): Promise<MemorySearchManagerResult> {
  try {
    const { MemoryIndexManager } = await loadManagerRuntime();
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manager: null, error: message };
  }
}

class BorrowedMemoryManager implements MemorySearchManager {
  readonly probeVectorStoreAvailability?: () => Promise<boolean>;

  constructor(private readonly inner: MemorySearchManager) {
    if (inner.probeVectorStoreAvailability) {
      const probeVectorStoreAvailability = inner.probeVectorStoreAvailability.bind(inner);
      this.probeVectorStoreAvailability = async () => await probeVectorStoreAvailability();
    }
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      sources?: MemorySource[];
      signal?: AbortSignal;
    },
  ) {
    return await this.inner.search(query, opts);
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    return await this.inner.readFile(params);
  }

  status() {
    return this.inner.status();
  }

  async sync(params?: MemorySyncParams) {
    await this.inner.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return await this.inner.probeEmbeddingAvailability();
  }

  async probeVectorAvailability() {
    return await this.inner.probeVectorAvailability();
  }

  async close() {}
}

export async function closeAllMemorySearchManagers(): Promise<void> {
  const pendingCreates = Array.from(PENDING_QMD_MANAGER_CREATES.values(), (entry) => entry.promise);
  await Promise.allSettled(pendingCreates);
  const managers = Array.from(QMD_MANAGER_CACHE.values(), (entry) => entry.manager);
  PENDING_QMD_MANAGER_CREATES.clear();
  QMD_MANAGER_CACHE.clear();
  QMD_MANAGER_OPEN_FAILURES.clear();
  for (const manager of managers) {
    try {
      await manager.close?.();
    } catch (err) {
      log.warn(`failed to close qmd memory manager: ${String(err)}`);
    }
  }
  const mem0Managers = Array.from(MEM0_MANAGER_CACHE.values());
  MEM0_MANAGER_CACHE.clear();
  for (const manager of mem0Managers) {
    try {
      await manager.close?.();
    } catch (err) {
      log.warn(`failed to close mem0 memory manager: ${String(err)}`);
    }
  }
  const hybridManagers = Array.from(HYBRID_MANAGER_CACHE.values());
  HYBRID_MANAGER_CACHE.clear();
  for (const manager of hybridManagers) {
    try {
      await manager.close?.();
    } catch (err) {
      log.warn(`failed to close hybrid memory manager: ${String(err)}`);
    }
  }
  if (managerRuntimePromise !== null) {
    const { closeAllMemoryIndexManagers } = await loadManagerRuntime();
    await closeAllMemoryIndexManagers();
  }
}

export async function closeMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const scopeKey = buildQmdManagerScopeKey(normalizedAgentId);
  const pending = PENDING_QMD_MANAGER_CREATES.get(scopeKey);
  if (pending) {
    await Promise.allSettled([pending.promise]);
  }
  const cached = QMD_MANAGER_CACHE.get(scopeKey);
  if (cached) {
    QMD_MANAGER_CACHE.delete(scopeKey);
    QMD_MANAGER_OPEN_FAILURES.delete(scopeKey);
    try {
      await cached.manager.close?.();
    } catch (err) {
      log.warn(`failed to close qmd memory manager for agent ${normalizedAgentId}: ${String(err)}`);
    }
  }
  if (managerRuntimePromise !== null) {
    const { closeMemoryIndexManagersForAgent } = await loadManagerRuntime();
    await closeMemoryIndexManagersForAgent({ cfg: params.cfg, agentId: normalizedAgentId });
  }
}

class FallbackMemoryManager implements MemorySearchManager {
  private fallback: MemorySearchManager | null = null;
  private primaryFailed = false;
  private lastError?: string;
  private cacheEvicted = false;
  private closed = false;
  private closeReason = "memory search manager is closed";

  constructor(
    private readonly deps: {
      primary: MemorySearchManager;
      fallbackFactory: () => Promise<MemorySearchManager | null>;
    },
    private readonly onClose?: () => void,
  ) {}

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      sources?: MemorySource[];
      signal?: AbortSignal;
    },
  ) {
    this.ensureOpen();
    if (!this.primaryFailed) {
      try {
        return await this.deps.primary.search(query, opts);
      } catch (err) {
        // Caller cancellation is request-scoped, not a QMD health failure.
        // Keep the shared manager active for concurrent and later searches.
        if (opts?.signal?.aborted) {
          throw err;
        }
        this.primaryFailed = true;
        this.lastError = formatErrorMessage(err);
        log.warn(`qmd memory failed; switching to builtin index: ${this.lastError}`);
        await this.deps.primary.close?.().catch(() => {});
        // Evict the failed wrapper so the next request can retry QMD with a fresh manager.
        this.evictCacheEntry();
      }
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.search(query, opts);
    }
    throw new Error(this.lastError ?? "memory search unavailable");
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return await this.deps.primary.readFile(params);
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.readFile(params);
    }
    throw new Error(this.lastError ?? "memory read unavailable");
  }

  status() {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return this.deps.primary.status();
    }
    const fallbackStatus = this.fallback?.status();
    const fallbackInfo = { from: "qmd", reason: this.lastError ?? "unknown" };
    if (fallbackStatus) {
      const custom = fallbackStatus.custom ?? {};
      return {
        ...fallbackStatus,
        fallback: fallbackInfo,
        custom: {
          ...custom,
          fallback: { disabled: true, reason: this.lastError ?? "unknown" },
        },
      };
    }
    const primaryStatus = this.deps.primary.status();
    const custom = primaryStatus.custom ?? {};
    return {
      ...primaryStatus,
      fallback: fallbackInfo,
      custom: {
        ...custom,
        fallback: { disabled: true, reason: this.lastError ?? "unknown" },
      },
    };
  }

  async sync(params?: MemorySyncParams) {
    this.ensureOpen();
    if (!this.primaryFailed) {
      await this.deps.primary.sync?.(params);
      return;
    }
    const fallback = await this.ensureFallback();
    await fallback?.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return await this.deps.primary.probeEmbeddingAvailability();
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.probeEmbeddingAvailability();
    }
    return { ok: false, error: this.lastError ?? "memory embeddings unavailable" };
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return this.deps.primary.getCachedEmbeddingAvailability?.() ?? null;
    }
    return this.fallback?.getCachedEmbeddingAvailability?.() ?? null;
  }

  async probeVectorStoreAvailability() {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return await (this.deps.primary.probeVectorStoreAvailability?.() ??
        this.deps.primary.probeVectorAvailability());
    }
    const fallback = await this.ensureFallback();
    return (
      (await (fallback?.probeVectorStoreAvailability?.() ?? fallback?.probeVectorAvailability())) ??
      false
    );
  }

  async probeVectorAvailability() {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return await this.deps.primary.probeVectorAvailability();
    }
    const fallback = await this.ensureFallback();
    return (await fallback?.probeVectorAvailability()) ?? false;
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.deps.primary.close?.();
    await this.fallback?.close?.();
    this.evictCacheEntry();
  }

  async invalidate(reason: string) {
    this.closeReason = reason;
    await this.close();
  }

  private async ensureFallback(): Promise<MemorySearchManager | null> {
    if (this.fallback) {
      return this.fallback;
    }
    let fallback: MemorySearchManager | null;
    try {
      fallback = await this.deps.fallbackFactory();
      if (!fallback) {
        log.warn("memory fallback requested but builtin index is unavailable");
        return null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`memory fallback unavailable: ${message}`);
      return null;
    }
    this.fallback = fallback;
    return this.fallback;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error(this.closeReason);
    }
  }

  private evictCacheEntry(): void {
    if (this.cacheEvicted) {
      return;
    }
    this.cacheEvicted = true;
    this.onClose?.();
  }
}

async function closeQmdManagerForReplacement(manager: MemorySearchManager): Promise<void> {
  if (manager instanceof FallbackMemoryManager) {
    await manager.invalidate("memory search manager was replaced by a newer qmd manager");
    return;
  }
  await manager.close?.();
}

function buildQmdManagerScopeKey(agentId: string): string {
  return agentId;
}

function buildQmdManagerIdentityKey(
  agentId: string,
  config: ResolvedQmdConfig,
  runtimeConfig: QmdManagerRuntimeConfig,
): string {
  return `${agentId}:${JSON.stringify(config)}:${JSON.stringify(runtimeConfig.syncSettings ?? null)}:${JSON.stringify(runtimeConfig.contextLimits ?? null)}:${runtimeConfig.workspaceDir}`;
}

function resolveQmdManagerRuntimeConfig(
  cfg: OpenClawConfig,
  agentId: string,
): QmdManagerRuntimeConfig {
  return {
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    syncSettings: resolveMemorySearchSyncConfig(cfg, agentId),
    contextLimits: resolveAgentContextLimits(cfg, agentId),
  };
}
