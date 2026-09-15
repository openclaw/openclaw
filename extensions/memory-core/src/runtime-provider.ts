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

export function createMemoryRuntime(host: MemoryCoreRuntimeHost = {}) {
  if (host.openKeyedStore) {
    configureMemoryCoreDreamingState(host.openKeyedStore);
  }

  return {
    prepareReload: prepareMemoryManagerReload,
    async getMemorySearchManager(params) {
      const { manager, debug, error, warning } = await getMemorySearchManager({
        ...params,
        ...(host.acquireLocalService ? { acquireLocalService: host.acquireLocalService } : {}),
      });
      return {
        manager,
        debug: debug
          ? {
              ...debug,
              purpose: params.purpose ?? "default",
            }
          : undefined,
        error,
        ...(warning ? { warning } : {}),
      };
    },
    async getReusableMemorySearchManager(params) {
      const { manager, debug, error, warning } = await getMemorySearchManager({
        ...params,
        purpose: "search",
        ...(host.acquireLocalService ? { acquireLocalService: host.acquireLocalService } : {}),
      });
      return {
        manager,
        debug: debug ? { backend: debug.backend, managerMs: debug.managerMs } : undefined,
        error,
        ...(warning ? { warning } : {}),
      };
    },
    resolveMemoryBackendConfig,
    async authorizeSearchHits(params) {
      const { filterMemorySearchHitsBySessionVisibility } =
        await import("./session-search-visibility.js");
      return await filterMemorySearchHitsBySessionVisibility(params);
    },
    classifyWorkspaceMemoryPaths,
    closeAllMemorySearchManagers,
    closeMemorySearchManager,
  } satisfies MemoryPluginRuntime;
}

export const memoryRuntime = createMemoryRuntime();
