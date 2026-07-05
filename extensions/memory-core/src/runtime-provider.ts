// Memory Core provider module implements model/runtime integration.
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager,
} from "./memory/index.js";

export const memoryRuntime: MemoryPluginRuntime = {
  async getMemorySearchManager(params) {
<<<<<<< HEAD
    const { manager, debug, error } = await getMemorySearchManager(params);
    return {
      manager,
      debug,
=======
    const { manager, error } = await getMemorySearchManager(params);
    return {
      manager,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      error,
    };
  },
  resolveMemoryBackendConfig(params) {
    return resolveMemoryBackendConfig(params);
  },
  async closeAllMemorySearchManagers() {
    await closeAllMemorySearchManagers();
  },
  async closeMemorySearchManager(params) {
    await closeMemorySearchManager(params);
  },
};
