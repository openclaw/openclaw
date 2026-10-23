import {
  createRemoteEmbeddingProvider,
  embeddingProviderOwnsDestination,
  isMissingEmbeddingApiKeyError,
  normalizeEmbeddingModelWithPrefixes,
  resolveRemoteEmbeddingClient,
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProviderAdapter,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { MISTRAL_BASE_URL } from "./model-definitions.js";

const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";
const EXCLUDED_EMBEDDING_HEADERS = ["authorization", "content-type", "x-api-key", "api-key"];

export const mistralMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "mistral",
  defaultModel: DEFAULT_MISTRAL_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "mistral",
  autoSelectPriority: 50,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    const preparedOptions: MemoryEmbeddingProviderCreateOptions = {
      ...options,
      provider: "mistral",
      fallback: "none",
    };
    const client = await resolveRemoteEmbeddingClient({
      provider: "mistral",
      options: preparedOptions,
      defaultBaseUrl: MISTRAL_BASE_URL,
      normalizeModel: (model) =>
        normalizeEmbeddingModelWithPrefixes({
          model,
          defaultModel: DEFAULT_MISTRAL_EMBEDDING_MODEL,
          prefixes: ["mistral/"],
        }),
    });
    const provider = createRemoteEmbeddingProvider({
      id: "mistral",
      client,
      errorPrefix: "mistral embeddings failed",
    });
    const headers = sanitizeEmbeddingCacheHeaders(client.headers, EXCLUDED_EMBEDDING_HEADERS);
    const usesDefaultIdentity =
      headers.length === 0 &&
      embeddingProviderOwnsDestination({
        baseUrl: client.baseUrl,
        providerBaseUrl: MISTRAL_BASE_URL,
      });
    return {
      provider,
      runtime: {
        id: "mistral",
        cacheKeyData: {
          provider: "mistral",
          model: client.model,
          ...(usesDefaultIdentity ? {} : { baseUrl: client.baseUrl, headers }),
        },
      },
    };
  },
};
