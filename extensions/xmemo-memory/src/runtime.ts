import type { MemoryPluginRuntime, OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { XMemoClient } from "./client.js";
import { resolveXMemoMemoryConfig } from "./config.js";
import { XMemoSearchManager } from "./search-manager.js";

export function createXMemoMemoryRuntime(api: OpenClawPluginApi): MemoryPluginRuntime {
  return {
    async getMemorySearchManager(params) {
      const cfg = resolveXMemoMemoryConfig(params.cfg);
      if (!cfg.token) {
        return {
          manager: null,
          error: "XMemo is not configured. Set XMEMO_KEY or configure the plugin token.",
        };
      }

      try {
        const client = new XMemoClient(cfg.baseUrl, cfg.token, cfg.agentId, cfg.agentInstanceId);
        const manager = new XMemoSearchManager(client, cfg);
        return { manager };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { manager: null, error: `XMemo memory runtime failed: ${message}` };
      }
    },

    resolveMemoryBackendConfig(params) {
      const cfg = resolveXMemoMemoryConfig(params.cfg);
      return {
        backend: "builtin",
      };
    },

    async closeMemorySearchManager() {
      // Stateless HTTP client; nothing to close.
    },

    async closeAllMemorySearchManagers() {
      // Stateless HTTP client; nothing to close.
    },
  };
}
