import type {
  MemoryPluginRuntime,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { XMemoClient } from "./client.js";
import { resolveXMemoMemoryConfig } from "./config.js";
import { XMemoSearchManager } from "./search-manager.js";

export function createXMemoMemoryRuntime(_api: OpenClawPluginApi): MemoryPluginRuntime {
  return {
    async getMemorySearchManager(params) {
      const cfg = resolveXMemoMemoryConfig(params.cfg);
      if (!cfg.apiKey) {
        return {
          manager: null,
          error: "XMemo is not configured. Set XMEMO_KEY or configure the plugin apiKey.",
        };
      }

      try {
        const client = new XMemoClient(
          cfg.baseUrl,
          cfg.apiKey ?? "",
          cfg.agentId,
          cfg.agentInstanceId,
          cfg.authMode,
        );
        const manager = new XMemoSearchManager(client, cfg);
        return { manager };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { manager: null, error: `XMemo memory runtime failed: ${message}` };
      }
    },

    resolveMemoryBackendConfig(params) {
      const cfg = resolveXMemoMemoryConfig(params.cfg);
      void cfg;
      return {
        backend: "xmemo",
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
