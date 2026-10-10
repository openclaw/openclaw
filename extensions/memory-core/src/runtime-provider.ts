// Memory Core provider module implements model/runtime integration.
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { configureMemoryCoreDreamingState } from "./dreaming-state.js";
import {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager,
} from "./memory/index.js";
import { prepareMemoryManagerReload } from "./memory/lifecycle.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";
import { classifyWorkspaceMemoryPaths } from "./workspace-path-classifier.js";

export function createMemoryRuntime(host: MemoryCoreRuntimeHost) {
  if (host.openKeyedStore) {
    configureMemoryCoreDreamingState(host.openKeyedStore);
  }

  return {
    prepareReload: prepareMemoryManagerReload,
    async getMemorySearchManager(params) {
      return await getMemorySearchManager({
        ...params,
        ...(host.acquireLocalService ? { acquireLocalService: host.acquireLocalService } : {}),
        runInBackgroundContext: host.runInBackgroundContext,
      });
    },
    resolveMemoryBackendConfig,
    async authorizeSearchHits(params) {
      const { filterMemorySearchHitsBySessionVisibility } =
        await import("./session-search-visibility.js");
      return await filterMemorySearchHitsBySessionVisibility(params);
    },
    supportsWorkspaceMemoryReadSources: true,
    classifyWorkspaceMemoryPaths,
    closeAllMemorySearchManagers,
    closeMemorySearchManager,
  } satisfies MemoryPluginRuntime;
}
