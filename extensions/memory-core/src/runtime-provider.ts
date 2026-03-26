import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core";
import {
  getMemorySearchManager,
  resolveMemoryBackendConfig,
} from "openclaw/plugin-sdk/memory-core";

export const memoryRuntime: MemoryPluginRuntime = {
  async getMemorySearchManager(params) {
    const { manager, error } = await getMemorySearchManager(params);
    return {
      manager,
      error,
    };
  },
  resolveMemoryBackendConfig(params) {
    return resolveMemoryBackendConfig(params);
  },
};
