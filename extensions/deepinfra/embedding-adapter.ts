import type { EmbeddingProviderAdapter } from "openclaw/plugin-sdk/embedding-providers";
import {
  embeddingProviderOwnsDestination,
  sanitizeEmbeddingCacheHeaders,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createDeepInfraEmbeddingProvider,
  DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
} from "./embedding-provider.js";
import { DEEPINFRA_BASE_URL } from "./media-models.js";

const EXCLUDED_EMBEDDING_HEADERS = ["authorization", "content-type", "x-api-key", "api-key"];

export const deepinfraEmbeddingProviderAdapter: EmbeddingProviderAdapter = {
  id: "deepinfra",
  defaultModel: DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "deepinfra",
  create: async (createOptions) => {
    const { provider, client } = await createDeepInfraEmbeddingProvider({
      ...createOptions,
      provider: "deepinfra",
      defaultModel: DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
    });
    const headers = sanitizeEmbeddingCacheHeaders(client.headers, EXCLUDED_EMBEDDING_HEADERS);
    const usesDefaultIdentity =
      headers.length === 0 &&
      embeddingProviderOwnsDestination({
        baseUrl: client.baseUrl,
        providerBaseUrl: DEEPINFRA_BASE_URL,
      });
    return {
      provider,
      runtime: {
        id: "deepinfra",
        cacheKeyData: {
          provider: "deepinfra",
          model: client.model,
          ...(usesDefaultIdentity ? {} : { baseUrl: client.baseUrl, headers }),
        },
      },
    };
  },
};
