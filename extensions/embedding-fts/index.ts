import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { loadFts5Extension, type Fts5LoadResult } from "./src/sqlite-fts5.js";
import {
  createNoopEmbeddingProvider,
  createTransformerEmbeddingProvider,
  withRetryBackoff,
  probeEmbeddingAvailability,
  type EmbeddingProvider,
  type EmbeddingFtsConfig,
} from "./src/embedding.js";

export { loadFts5Extension, type Fts5LoadResult } from "./src/sqlite-fts5.js";
export {
  createNoopEmbeddingProvider,
  createTransformerEmbeddingProvider,
  withRetryBackoff,
  probeEmbeddingAvailability,
  type EmbeddingProvider,
  type EmbeddingFtsConfig,
} from "./src/embedding.js";

const plugin = {
  id: "embedding-fts",
  name: "Embedding & FTS",
  description:
    "Unified embedding system with FTS5 fallback, dim-mismatch protection and 429 retry-with-backoff",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    if (!cfg.enabled) {
      return; // Plugin disabled by default — set enabled: true to activate
    }
    // This plugin provides library utilities consumed by other plugins
    // (e.g. memory-context). No hooks registered — just exports.
    api.on("health", () => {
      return {
        embeddingFts: {
          available: true,
          description:
            "Unified embedding system with FTS5 fallback, dim-mismatch protection and 429 retry.",
        },
      };
    });
  },
};

export default plugin;
