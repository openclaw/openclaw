import type { EmbeddingProviderAdapter } from "openclaw/plugin-sdk/embedding-providers";
import {
  createRemoteEmbeddingProvider,
  embeddingProviderOwnsDestination,
  resolveRemoteEmbeddingClient,
  sanitizeEmbeddingCacheHeaders,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_EMBED_FALLBACK_MODELS,
  normalizeDeepInfraModelRef,
} from "./media-models.js";

const DEFAULT_DEEPINFRA_EMBEDDING_MODEL = DEEPINFRA_EMBED_FALLBACK_MODELS[0];
const EXCLUDED_EMBEDDING_HEADERS = ["authorization", "content-type", "x-api-key", "api-key"];

export const deepinfraEmbeddingProviderAdapter: EmbeddingProviderAdapter = {
  id: "deepinfra",
  defaultModel: DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "deepinfra",
  create: async (createOptions) => {
    const client = await resolveRemoteEmbeddingClient({
      provider: "deepinfra",
      options: {
        ...createOptions,
        provider: "deepinfra",
        model: normalizeDeepInfraModelRef(createOptions.model, DEFAULT_DEEPINFRA_EMBEDDING_MODEL),
      },
      defaultBaseUrl: DEEPINFRA_BASE_URL,
      normalizeModel: (model) =>
        normalizeDeepInfraModelRef(model, DEFAULT_DEEPINFRA_EMBEDDING_MODEL),
    });
    const provider = createRemoteEmbeddingProvider({
      id: "deepinfra",
      client,
      errorPrefix: "DeepInfra embeddings API error",
      // DeepInfra query and document payloads are identical, so arrays stay one provider batch.
      batchQueryInputs: true,
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
