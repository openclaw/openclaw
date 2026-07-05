// Ollama plugin module implements memory embedding adapter behavior.
import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  createOllamaEmbeddingProvider,
} from "./embedding-provider.js";

export const ollamaMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "ollama",
  defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "ollama",
  create: async (options) => {
    const { provider, client } = await createOllamaEmbeddingProvider({
      ...options,
      provider: "ollama",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "ollama",
        inlineBatchTimeoutMs: 10 * 60_000,
        cacheKeyData: {
          provider: "ollama",
          model: client.model,
<<<<<<< HEAD
          outputDimensionality: client.outputDimensionality,
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
        },
      },
    };
  },
};
