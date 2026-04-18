// Memory Core provider module implements model/runtime integration.
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager,
} from "./memory/index.js";

function toRuntimeBackendConfig(
  resolved: ReturnType<typeof resolveMemoryBackendConfig>,
): ReturnType<MemoryPluginRuntime["resolveMemoryBackendConfig"]> {
  if (resolved.backend === "mem0" && resolved.mem0) {
    return {
      backend: "mem0",
      mem0: {
        baseUrl: resolved.mem0.baseUrl,
        searchPath: resolved.mem0.searchPath,
        addPath: resolved.mem0.addPath,
        topK: resolved.mem0.topK,
        threshold: resolved.mem0.threshold,
        timeoutMs: resolved.mem0.timeoutMs,
      },
    };
  }
  if (resolved.backend === "hybrid" && resolved.mem0) {
    return {
      backend: "hybrid",
      mem0: {
        baseUrl: resolved.mem0.baseUrl,
        searchPath: resolved.mem0.searchPath,
        addPath: resolved.mem0.addPath,
        topK: resolved.mem0.topK,
        threshold: resolved.mem0.threshold,
        timeoutMs: resolved.mem0.timeoutMs,
      },
      qmd: resolved.qmd ? { command: resolved.qmd.command } : undefined,
      hybrid: resolved.hybrid
        ? {
            readMode: resolved.hybrid.readMode,
            writeMode: resolved.hybrid.writeMode,
            successPolicy: resolved.hybrid.successPolicy,
          }
        : undefined,
    };
  }
  if (resolved.backend === "qmd") {
    return {
      backend: "qmd",
      qmd: resolved.qmd ? { command: resolved.qmd.command } : undefined,
    };
  }
  return { backend: "builtin" };
}

export const memoryRuntime: MemoryPluginRuntime = {
  async getMemorySearchManager(params) {
    const { manager, debug, error } = await getMemorySearchManager(params);
    return {
      manager,
      debug,
      error,
    };
  },
  resolveMemoryBackendConfig(params) {
    return toRuntimeBackendConfig(resolveMemoryBackendConfig(params));
  },
  async closeAllMemorySearchManagers() {
    await closeAllMemorySearchManagers();
  },
  async closeMemorySearchManager(params) {
    await closeMemorySearchManager(params);
  },
};
