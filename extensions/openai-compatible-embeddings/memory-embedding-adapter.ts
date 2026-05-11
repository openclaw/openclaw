import {
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createOpenAICompatibleEmbeddingProvider,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "./embedding-provider.js";

/**
 * Adapter for any local OpenAI-compatible HTTP embedding server.
 *
 * Distinct from the in-process `local` adapter (transport: "local") that
 * uses node-llama-cpp on a local `.gguf` file: this adapter is purely
 * HTTP and uses `transport: "remote"` so the engine routes it through the
 * same SSRF + remote-fetch path as the cloud adapters.
 *
 * `autoSelectPriority` is intentionally absent: this provider must be
 * chosen explicitly via `embedding.provider: "openai-compatible"`. We do
 * not want auto-selection because every operator who has any other API
 * key configured (OpenAI, Mistral, Voyage, etc.) would otherwise auto-
 * route embeddings to the cloud the moment they enabled memory-lancedb.
 *
 * `authProviderId` is also absent: there is no centralized auth flow for
 * arbitrary local servers. The optional `apiKey` lives directly in the
 * per-plugin `embedding` config block, treated as a raw bearer.
 */
export const openaiCompatibleMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: OPENAI_COMPATIBLE_PROVIDER_ID,
  transport: "remote",
  allowExplicitWhenConfiguredAuto: true,
  create: async (options) => {
    const { provider, client } = await createOpenAICompatibleEmbeddingProvider(options);
    return {
      provider,
      runtime: {
        id: OPENAI_COMPATIBLE_PROVIDER_ID,
        inlineBatchTimeoutMs: 10 * 60_000,
        cacheKeyData: {
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          baseUrl: client.baseUrl,
          model: client.model,
          headers: sanitizeEmbeddingCacheHeaders(client.headers, ["authorization"]),
        },
      },
    };
  },
};
