// Memory Core owns compatible shared document indexes separately from per-agent databases.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  createSubsystemLogger,
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveGlobalSingleton,
  resolveMemorySearchConfig,
  resolveStateDir,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  openSqliteWorkerStore,
  runQueuedStoreWrite,
  runSqliteWorkerStoreWrite,
  type OpenClawAgentSqliteWorkerStore,
  type SqliteWorkerStore,
  type StoreWriterQueue,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveEmbeddingProviderIndexIdentity } from "./embeddings.js";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
  openMemoryDatabaseReadOnlyFileAtPath,
} from "./manager-db.js";
import { resolveMemoryPrimaryProviderRequest } from "./manager-provider-state.js";
import type { MemoryPublicationOperations } from "./manager-publication-task.js";
import { resolveConfiguredScopeHash } from "./manager-reindex-state.js";
import { assertMemoryShadowIdentity, readMemoryShadowIdentity } from "./manager-shadow-task.js";

const log = createSubsystemLogger("memory");

export type SharedMemoryIndexScope = {
  compatibilityHash: string;
  path: string;
  systemAgentId: string;
  workspaceDir: string;
};

export type SharedMemoryDatabaseLease = {
  readonly db: DatabaseSync;
  readonly path: string;
  drainWrites(): Promise<void>;
  openPublicationWorker(worker: {
    moduleUrl: URL;
    input: unknown;
  }): Promise<OpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>>;
  release(): void;
  withWrite<T>(operation: () => T): Promise<T>;
};

type SharedMemoryDatabaseState = {
  allowExtension: boolean;
  closed: boolean;
  compatibilityHash: string;
  db: DatabaseSync;
  path: string;
  queues: Map<string, StoreWriterQueue>;
  references: number;
  workspaceDir: string;
};

const sharedDatabaseStates = resolveGlobalSingleton(
  Symbol.for("openclaw.memory-core.shared-database-states"),
  () => new Map<string, SharedMemoryDatabaseState>(),
);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function resolveSharedIndexCompatibilityHash(params: {
  agentId: string;
  cfg: OpenClawConfig;
  settings: ResolvedMemorySearchConfig;
  workspaceDir: string;
}): string {
  const providerIdentity = resolveEmbeddingProviderIndexIdentity({
    config: params.cfg,
    agentDir: resolveAgentDir(params.cfg, params.agentId),
    ...resolveMemoryPrimaryProviderRequest({ settings: params.settings }),
  });
  const remote = params.settings.remote;
  return hashText(
    JSON.stringify(
      stableValue({
        chunking: params.settings.chunking,
        documentInputType: params.settings.documentInputType,
        extraPaths: params.settings.extraPaths,
        ftsTokenizer: params.settings.store.fts.tokenizer,
        inputType: params.settings.inputType,
        local: params.settings.local,
        model: params.settings.model,
        multimodal: params.settings.multimodal,
        outputDimensionality: params.settings.outputDimensionality,
        provider: params.settings.provider,
        providerIdentity,
        queryInputType: params.settings.queryInputType,
        remote: remote
          ? {
              baseUrl: remote.baseUrl,
              batch: remote.batch,
              hasApiKey: remote.apiKey !== undefined,
              headerNames: Object.keys(remote.headers ?? {}).toSorted(),
            }
          : undefined,
        scopeHash: resolveConfiguredScopeHash({
          workspaceDir: params.workspaceDir,
          extraPaths: params.settings.extraPaths,
          multimodal: params.settings.multimodal,
        }),
        searchSources: [...params.settings.searchSources].toSorted((left, right) =>
          left.localeCompare(right),
        ),
        sources: [...params.settings.sources].toSorted((left, right) => left.localeCompare(right)),
        vector: params.settings.store.vector,
        workspaceDir: path.resolve(params.workspaceDir),
      }),
    ),
  );
}

/** Resolve membership and full index compatibility before any shared database I/O. */
export function resolveSharedMemoryIndexScope(params: {
  agentId: string;
  cfg: OpenClawConfig;
  settings: ResolvedMemorySearchConfig;
  workspaceDir: string;
}): SharedMemoryIndexScope | null {
  const agentId = normalizeAgentId(params.agentId);
  const configuredSystemAgentId = params.cfg.agents?.defaults?.systemAgent?.agentId?.trim() ?? "";
  if (!configuredSystemAgentId) {
    return null;
  }
  const systemAgentId = normalizeAgentId(configuredSystemAgentId);
  const configuredAgentIds = new Set(listAgentIds(params.cfg).map(normalizeAgentId));
  if (!configuredAgentIds.has(agentId) || !configuredAgentIds.has(systemAgentId)) {
    return null;
  }
  const workspaceDir = path.resolve(params.workspaceDir);
  const agentWorkspaceDir = path.resolve(resolveAgentWorkspaceDir(params.cfg, agentId));
  if (workspaceDir !== agentWorkspaceDir) {
    return null;
  }
  const systemWorkspaceDir = path.resolve(resolveAgentWorkspaceDir(params.cfg, systemAgentId));
  if (workspaceDir !== systemWorkspaceDir) {
    return null;
  }
  let systemSettings: ResolvedMemorySearchConfig | null = params.settings;
  if (agentId !== systemAgentId) {
    try {
      systemSettings = resolveMemorySearchConfig(params.cfg, systemAgentId);
    } catch {
      return null;
    }
  }
  if (!systemSettings) {
    return null;
  }
  if (
    params.settings.sources.includes("sessions") ||
    params.settings.searchSources.includes("sessions") ||
    systemSettings.sources.includes("sessions") ||
    systemSettings.searchSources.includes("sessions")
  ) {
    return null;
  }
  const compatibilityHash = resolveSharedIndexCompatibilityHash({
    agentId,
    cfg: params.cfg,
    settings: params.settings,
    workspaceDir,
  });
  const systemCompatibilityHash = resolveSharedIndexCompatibilityHash({
    agentId: systemAgentId,
    cfg: params.cfg,
    settings: systemSettings,
    workspaceDir: systemWorkspaceDir,
  });
  if (compatibilityHash !== systemCompatibilityHash) {
    return null;
  }
  const workspaceHash = hashText(JSON.stringify({ workspace: workspaceDir })).slice(0, 16);
  return {
    compatibilityHash,
    path: path.join(
      resolveStateDir(process.env),
      "state",
      "memory",
      `shared-${workspaceHash}.sqlite`,
    ),
    systemAgentId,
    workspaceDir,
  };
}

function assertSharedDatabaseState(state: SharedMemoryDatabaseState): void {
  if (state.closed || !state.db.isOpen) {
    throw new Error("Shared memory database owner is closed");
  }
}

async function drainSharedDatabaseWrites(state: SharedMemoryDatabaseState): Promise<void> {
  while (state.queues.size > 0) {
    await Promise.allSettled(
      Array.from(state.queues.values()).flatMap((queue) =>
        queue.drainPromise ? [queue.drainPromise] : [],
      ),
    );
  }
}

function runSharedDatabaseMaintenance(
  state: SharedMemoryDatabaseState,
  operation: () => boolean,
): boolean {
  if (state.closed || !state.db.isOpen) {
    return false;
  }
  void runQueuedStoreWrite({
    queues: state.queues,
    storePath: state.path,
    label: "shared memory WAL maintenance",
    fn: async () => {
      assertSharedDatabaseState(state);
      return operation();
    },
  }).catch((error: unknown) => {
    log.warn(`shared memory WAL maintenance failed: ${String(error)}`);
  });
  return false;
}

function createSharedDatabaseState(params: {
  allowExtension: boolean;
  scope: SharedMemoryIndexScope;
}): SharedMemoryDatabaseState {
  const dbPath = path.resolve(params.scope.path);
  const existing = sharedDatabaseStates.get(dbPath);
  if (existing) {
    if (
      existing.compatibilityHash !== params.scope.compatibilityHash ||
      existing.allowExtension !== params.allowExtension
    ) {
      throw new Error("Shared memory database identity changed before owner reuse");
    }
    existing.references += 1;
    return existing;
  }

  const stateRef: { current?: SharedMemoryDatabaseState } = {};
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openMemoryDatabaseAtPath(dbPath, params.allowExtension, (operation) => {
    const state = stateRef.current;
    if (!state) {
      return false;
    }
    return runSharedDatabaseMaintenance(state, operation);
  });
  const state: SharedMemoryDatabaseState = {
    allowExtension: params.allowExtension,
    closed: false,
    compatibilityHash: params.scope.compatibilityHash,
    db,
    path: dbPath,
    queues: new Map(),
    references: 1,
    workspaceDir: params.scope.workspaceDir,
  };
  stateRef.current = state;
  sharedDatabaseStates.set(dbPath, state);
  return state;
}

function releaseSharedDatabaseState(state: SharedMemoryDatabaseState): void {
  state.references -= 1;
  if (state.references > 0) {
    return;
  }
  state.closed = true;
  sharedDatabaseStates.delete(state.path);
  if (state.db.isOpen) {
    closeMemoryDatabase(state.db);
  }
}

function sharedWriteLease(state: SharedMemoryDatabaseState): SharedMemoryDatabaseLease {
  let released = false;
  return {
    db: state.db,
    path: state.path,
    async drainWrites() {
      await drainSharedDatabaseWrites(state);
    },
    async openPublicationWorker(worker) {
      assertSharedDatabaseState(state);
      const fileIdentity = readMemoryShadowIdentity(state.path);
      const store = await openSqliteWorkerStore<MemoryPublicationOperations>({
        moduleUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication),
        databasePath: state.path,
        existingOnly: true,
        input: worker.input,
        admission: {
          identity: `file:${fileIdentity.device}:${fileIdentity.inode}`,
          assertCurrent: () => {
            assertSharedDatabaseState(state);
            assertMemoryShadowIdentity(state.path, fileIdentity);
          },
        },
      });
      if (!store) {
        throw new Error("Shared memory database disappeared before publication Worker open");
      }
      const assertCurrent = () => {
        assertSharedDatabaseState(state);
        assertMemoryShadowIdentity(state.path, fileIdentity);
      };
      return {
        run<T>(
          operation: (
            scope: Pick<SqliteWorkerStore<MemoryPublicationOperations>, "execute">,
          ) => Promise<T>,
          assertLeaseCurrent: () => void,
        ): Promise<T> {
          return runQueuedStoreWrite({
            queues: state.queues,
            storePath: state.path,
            label: "shared memory publication",
            fn: async () => {
              assertCurrent();
              assertLeaseCurrent();
              return await runSqliteWorkerStoreWrite(
                store,
                operation,
                () => {
                  assertCurrent();
                  assertLeaseCurrent();
                },
                [state.path],
              );
            },
          });
        },
        close: () => store.close(),
      };
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      releaseSharedDatabaseState(state);
    },
    async withWrite<T>(operation: () => T): Promise<T> {
      return await runQueuedStoreWrite({
        queues: state.queues,
        storePath: state.path,
        label: "shared memory write",
        fn: async () => {
          assertSharedDatabaseState(state);
          return operation();
        },
      });
    },
  };
}

/** Acquire the process-wide owner for one compatible shared document index. */
export function acquireSharedMemoryDatabase(params: {
  allowExtension: boolean;
  readOnly: boolean;
  scope: SharedMemoryIndexScope;
}): SharedMemoryDatabaseLease {
  if (params.readOnly) {
    const opened = openMemoryDatabaseReadOnlyFileAtPath(params.scope.path, params.allowExtension);
    return {
      db: opened.db,
      path: path.resolve(params.scope.path),
      async drainWrites() {},
      async openPublicationWorker() {
        throw new Error("Memory status managers are read-only");
      },
      release: opened.release,
      async withWrite(): Promise<never> {
        throw new Error("Memory status managers are read-only");
      },
    };
  }
  return sharedWriteLease(
    createSharedDatabaseState({
      allowExtension: params.allowExtension,
      scope: params.scope,
    }),
  );
}
