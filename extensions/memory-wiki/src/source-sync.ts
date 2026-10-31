import type { OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources } from "./bridge.js";
import {
  refreshMemoryWikiIndexesAfterImport,
  type RefreshMemoryWikiIndexesResult,
} from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  resolveMemoryWikiVaultMutationKey,
  withMemoryWikiVaultMutation,
} from "./mutation-coordinator.js";
import { emptySourceImportResult, type BridgeMemoryWikiResult } from "./source-import.js";
import { syncMemoryWikiUnsafeLocalSources } from "./unsafe-local.js";
import { initializeMemoryWikiVault } from "./vault.js";

export type MemoryWikiImportedSourceSyncResult = BridgeMemoryWikiResult & {
  indexesRefreshed: boolean;
  indexUpdatedFiles: string[];
  indexRefreshReason: RefreshMemoryWikiIndexesResult["reason"] | "deferred";
};

type SyncMemoryWikiImportedSourcesParams = {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  signal?: AbortSignal;
  /** Set when the caller compiles next (compile, lint), so the import does not compile too. */
  deferIndexRefresh?: boolean;
};

type ActiveImportedSourceSync = {
  requestKey: string;
  appConfig?: OpenClawConfig;
  signal?: AbortSignal;
  promise: Promise<MemoryWikiImportedSourceSyncResult>;
};

const activeImportedSourceSyncs = new Map<string, Set<ActiveImportedSourceSync>>();

async function syncMemoryWikiImportedSourcesOnce(
  params: SyncMemoryWikiImportedSourcesParams,
): Promise<MemoryWikiImportedSourceSyncResult> {
  params.signal?.throwIfAborted();
  let syncResult: BridgeMemoryWikiResult;
  if (params.config.vaultMode === "bridge") {
    syncResult = await syncMemoryWikiBridgeSources(params);
  } else if (params.config.vaultMode === "unsafe-local") {
    syncResult = params.signal
      ? await syncMemoryWikiUnsafeLocalSources(params.config, { signal: params.signal })
      : await syncMemoryWikiUnsafeLocalSources(params.config);
  } else {
    // Local mode has no importer to activate the cache before readiness is checked.
    await initializeMemoryWikiVault(
      params.config,
      params.signal ? { signal: params.signal } : undefined,
    );
    syncResult = emptySourceImportResult();
  }
  params.signal?.throwIfAborted();
  if (params.deferIndexRefresh) {
    return {
      ...syncResult,
      indexesRefreshed: false,
      indexUpdatedFiles: [],
      indexRefreshReason: "deferred",
    };
  }
  const refreshResult = await refreshMemoryWikiIndexesAfterImport({
    config: params.config,
    syncResult,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return {
    ...syncResult,
    indexesRefreshed: refreshResult.refreshed,
    indexUpdatedFiles: refreshResult.compile?.updatedFiles ?? [],
    indexRefreshReason: refreshResult.reason,
  };
}

export async function syncMemoryWikiImportedSources(
  params: SyncMemoryWikiImportedSourcesParams,
): Promise<MemoryWikiImportedSourceSyncResult> {
  const vaultKey = await resolveMemoryWikiVaultMutationKey(params.config.vault.path);
  const requestKey = JSON.stringify({
    ...params.config,
    vault: { ...params.config.vault, path: vaultKey },
    deferIndexRefresh: params.deferIndexRefresh === true,
  });
  const active = activeImportedSourceSyncs.get(vaultKey) ?? new Set<ActiveImportedSourceSync>();
  const matching = [...active].find(
    (entry) =>
      entry.requestKey === requestKey &&
      entry.appConfig === params.appConfig &&
      entry.signal === params.signal,
  );
  if (matching) {
    return await matching.promise;
  }

  // Equivalent polls share the whole source-and-index flight. Different
  // snapshots still queue on the common vault transaction boundary.
  const promise = withMemoryWikiVaultMutation(params.config.vault.path, () =>
    syncMemoryWikiImportedSourcesOnce(params),
  );
  const entry: ActiveImportedSourceSync = {
    requestKey,
    appConfig: params.appConfig,
    signal: params.signal,
    promise,
  };
  active.add(entry);
  activeImportedSourceSyncs.set(vaultKey, active);

  try {
    return await promise;
  } finally {
    active.delete(entry);
    if (active.size === 0) {
      activeImportedSourceSyncs.delete(vaultKey);
    }
  }
}

export async function waitForMemoryWikiImportedSourceSyncs(): Promise<void> {
  await Promise.allSettled(
    [...activeImportedSourceSyncs.values()].flatMap((entries) =>
      [...entries].map((entry) => entry.promise),
    ),
  );
}

/** Demand-driven maintenance belongs to the service, never to a search deadline. */
export function createMemoryWikiSourceRefresh(options: {
  signal: AbortSignal;
  onError: (config: ResolvedMemoryWikiConfig, error: unknown) => void;
}) {
  type Refresh = {
    requestKey: string;
    appConfig?: OpenClawConfig;
    pending: boolean;
    nextRunAt: number;
    failures: number;
    timer?: ReturnType<typeof setTimeout>;
  };
  const refreshes = new Map<string, Refresh>();
  const { signal } = options;
  signal.addEventListener(
    "abort",
    () => {
      for (const refresh of refreshes.values()) {
        clearTimeout(refresh.timer);
      }
      refreshes.clear();
    },
    { once: true },
  );

  return (config: ResolvedMemoryWikiConfig, appConfig?: OpenClawConfig): void => {
    if (signal.aborted) {
      return;
    }
    void (async () => {
      const vaultKey = await resolveMemoryWikiVaultMutationKey(config.vault.path);
      if (signal.aborted) {
        return;
      }
      const requestKey = JSON.stringify({ ...config, vault: { ...config.vault, path: vaultKey } });
      let refresh = refreshes.get(vaultKey);
      if (!refresh || refresh.requestKey !== requestKey || refresh.appConfig !== appConfig) {
        clearTimeout(refresh?.timer);
        refresh = { requestKey, appConfig, pending: false, nextRunAt: 0, failures: 0 };
        refreshes.set(vaultKey, refresh);
      }
      const state = refresh;
      const run = async () => {
        if (signal.aborted || refreshes.get(vaultKey) !== state || state.pending) {
          return;
        }
        state.pending = true;
        clearTimeout(state.timer);
        state.timer = undefined;
        try {
          await syncMemoryWikiImportedSources({ config, appConfig, signal });
          state.failures = 0;
          // Coalesce successful checks too: dashboard polls and searches must not
          // repeatedly stat every imported source. Explicit imports bypass this.
          state.nextRunAt = Date.now() + 60_000;
        } catch (error) {
          if (signal.aborted || refreshes.get(vaultKey) !== state) {
            return;
          }
          const delay = Math.min(60_000, 5_000 * 2 ** Math.min(state.failures++, 4));
          state.nextRunAt = Date.now() + delay;
          state.timer = setTimeout(() => {
            void run();
          }, delay);
          state.timer.unref?.();
          options.onError(config, error);
        } finally {
          state.pending = false;
        }
      };
      if (!state.pending && !state.timer && Date.now() >= state.nextRunAt) {
        await run();
      }
    })().catch((error: unknown) => {
      if (!signal.aborted) {
        options.onError(config, error);
      }
    });
  };
}
