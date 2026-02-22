/**
 * Runner Extensions Plugin
 *
 * Provides the dynamic pi-extension loading infrastructure that wires
 * memory-context, compaction-safeguard, and context-pruning extensions
 * into the embedded agent runner.
 *
 * Key responsibilities:
 *  - Dynamic extension path resolution (dev `.ts` → production `.js` with jiti fallback)
 *  - Per-session memory-context resource caching (WarmStore, KnowledgeStore, embedding)
 *  - Embedding upgrade probes: periodically re-probe fallback embeddings and swap in better ones
 *  - Config schema for `memoryContext` agent defaults (enabled, hardCapTokens, embeddingModel, etc.)
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import {
  resolveExtensionPath,
  buildExtensionPaths,
  type ExtensionPathsParams,
  type MemoryContextAgentConfig,
} from "./src/extension-loader.js";

export {
  resolveExtensionPath,
  buildExtensionPaths,
  type ExtensionPathsParams,
  type MemoryContextAgentConfig,
} from "./src/extension-loader.js";

const plugin = {
  id: "runner-extensions",
  name: "Runner Extensions",
  description:
    "Dynamic pi-extension loader with memory-context wiring, embedding upgrade probes, and compaction safeguard integration",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.on("health", () => {
      return {
        runnerExtensions: {
          available: true,
          description:
            "Dynamic pi-extension loading with memory-context wiring and embedding upgrade probes.",
        },
      };
    });
  },
};

export default plugin;
