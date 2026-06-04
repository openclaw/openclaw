import type { OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources, type BridgeMemoryWikiResult } from "./bridge.js";
import {
  refreshMemoryWikiIndexesAfterImport,
  type RefreshMemoryWikiIndexesResult,
} from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { syncMemoryWikiLocalImportSources } from "./local-import.js";
import { syncMemoryWikiUnsafeLocalSources } from "./unsafe-local.js";

export type MemoryWikiImportedSourceSyncResult = BridgeMemoryWikiResult & {
  indexesRefreshed: boolean;
  indexUpdatedFiles: string[];
  indexRefreshReason: RefreshMemoryWikiIndexesResult["reason"];
};

export async function syncMemoryWikiImportedSources(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
}): Promise<MemoryWikiImportedSourceSyncResult> {
  const syncResults: BridgeMemoryWikiResult[] = [];
  if (params.config.vaultMode === "bridge") {
    syncResults.push(await syncMemoryWikiBridgeSources(params));
  } else if (params.config.vaultMode === "unsafe-local") {
    syncResults.push(await syncMemoryWikiUnsafeLocalSources(params.config));
  }
  if (params.config.localImports?.enabled) {
    syncResults.push(await syncMemoryWikiLocalImportSources(params.config));
  }
  const syncResult = syncResults.reduce<BridgeMemoryWikiResult>(
    (acc, result) => ({
      importedCount: acc.importedCount + result.importedCount,
      updatedCount: acc.updatedCount + result.updatedCount,
      skippedCount: acc.skippedCount + result.skippedCount,
      removedCount: acc.removedCount + result.removedCount,
      artifactCount: acc.artifactCount + result.artifactCount,
      workspaces: acc.workspaces + result.workspaces,
      pagePaths: [...acc.pagePaths, ...result.pagePaths].toSorted((left, right) =>
        left.localeCompare(right),
      ),
    }),
    {
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
    },
  );
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
