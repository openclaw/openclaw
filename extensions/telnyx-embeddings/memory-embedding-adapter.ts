import {
  isMissingEmbeddingApiKeyError,
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createTelnyxEmbeddingProvider,
  DEFAULT_TELNYX_EMBEDDING_MODEL,
} from "./embedding-provider.js";

export const telnyxMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "telnyx",
  defaultModel: DEFAULT_TELNYX_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "telnyx",
  autoSelectPriority: 25,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    const { provider, client } = await createTelnyxEmbeddingProvider(options);
    return {
      provider,
      runtime: {
        id: "telnyx",
        cacheKeyData: {
          provider: "telnyx",
          baseUrl: client.baseUrl,
          model: client.model,
          headers: sanitizeEmbeddingCacheHeaders(client.headers, ["authorization"]),
        },
      },
    };
  },
};
