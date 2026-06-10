// Memory Wiki plugin module implements source sync behavior.
import path from "node:path";
import type { OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources, type BridgeMemoryWikiResult } from "./bridge.js";
import {
  refreshMemoryWikiIndexesAfterImport,
  type RefreshMemoryWikiIndexesResult,
} from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { syncMemoryWikiUnsafeLocalSources } from "./unsafe-local.js";

export type MemoryWikiImportedSourceSyncResult = BridgeMemoryWikiResult & {
  indexesRefreshed: boolean;
  indexUpdatedFiles: string[];
  indexRefreshReason: RefreshMemoryWikiIndexesResult["reason"];
};

type SyncMemoryWikiImportedSourcesParams = {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
};

const inFlightImportedSourceSyncs = new Map<string, Promise<MemoryWikiImportedSourceSyncResult>>();

function resolveImportedSourceSyncKey(params: SyncMemoryWikiImportedSourcesParams): string {
  return JSON.stringify({
    vaultPath: path.resolve(params.config.vault.path),
    vaultMode: params.config.vaultMode,
    vault: {
      renderMode: params.config.vault.renderMode,
    },
    bridge: params.config.bridge,
    ingest: params.config.ingest,
    render: params.config.render,
    search: params.config.search,
    context: params.config.context,
    obsidian: params.config.obsidian,
    agents:
      params.appConfig?.agents?.list?.map((agent) => ({
        id: agent.id,
        default: agent.default === true,
        workspace: agent.workspace,
      })) ?? null,
  });
}

async function syncMemoryWikiImportedSourcesOnce(
  params: SyncMemoryWikiImportedSourcesParams,
): Promise<MemoryWikiImportedSourceSyncResult> {
  let syncResult: BridgeMemoryWikiResult;
  if (params.config.vaultMode === "bridge") {
    syncResult = await syncMemoryWikiBridgeSources(params);
  } else if (params.config.vaultMode === "unsafe-local") {
    syncResult = await syncMemoryWikiUnsafeLocalSources(params.config);
  } else {
    syncResult = {
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
    };
  }
  const refreshResult = await refreshMemoryWikiIndexesAfterImport({
    config: params.config,
    syncResult,
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
  if (params.config.vaultMode !== "bridge") {
    return await syncMemoryWikiImportedSourcesOnce(params);
  }
  const syncKey = resolveImportedSourceSyncKey(params);
  const inFlight = inFlightImportedSourceSyncs.get(syncKey);
  if (inFlight) {
    return await inFlight;
  }
  const sync = syncMemoryWikiImportedSourcesOnce(params).finally(() => {
    inFlightImportedSourceSyncs.delete(syncKey);
  });
  inFlightImportedSourceSyncs.set(syncKey, sync);
  return await sync;
}
