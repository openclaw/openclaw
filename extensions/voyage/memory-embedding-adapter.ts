import {
  isMissingEmbeddingApiKeyError,
  mapBatchEmbeddingsByIndex,
  sanitizeEmbeddingCacheHeaders,
} from "openclaw/plugin-sdk/embedding-provider-adapter";
import {
  createRemoteEmbeddingProvider,
  normalizeEmbeddingModelWithPrefixes,
  resolveRemoteEmbeddingClient,
  type MemoryEmbeddingProviderAdapter,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { runVoyageEmbeddingBatches } from "./embedding-batch.js";

const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-4-large";
const DEFAULT_VOYAGE_BASE_URL = "https://api.voyageai.com/v1";
const VOYAGE_MAX_INPUT_TOKENS: Record<string, number> = {
  "voyage-3": 32000,
  "voyage-3-lite": 16000,
  "voyage-code-3": 32000,
};

export const voyageMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "voyage",
  defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "voyage",
  autoSelectPriority: 40,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    const preparedOptions: MemoryEmbeddingProviderCreateOptions = {
      ...options,
      provider: "voyage",
      fallback: "none",
    };
    const client = await resolveRemoteEmbeddingClient({
      provider: "voyage",
      options: preparedOptions,
      defaultBaseUrl: DEFAULT_VOYAGE_BASE_URL,
      normalizeModel: (model) =>
        normalizeEmbeddingModelWithPrefixes({
          model,
          defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
          prefixes: ["voyage/"],
        }),
    });
    const provider = createRemoteEmbeddingProvider({
      id: "voyage",
      client,
      errorPrefix: "voyage embeddings failed",
      buildRequestFields: (kind) => ({ input_type: kind }),
    });
    provider.maxInputTokens = VOYAGE_MAX_INPUT_TOKENS[client.model];
    return {
      provider,
      runtime: {
        id: "voyage",
        cacheKeyData: {
          provider: "voyage",
          baseUrl: client.baseUrl,
          model: client.model,
          headers: sanitizeEmbeddingCacheHeaders(client.headers, ["authorization"]),
        },
        batchEmbed: async (batch) => {
          const byCustomId = await runVoyageEmbeddingBatches({
            ...batch,
            client,
            requests: batch.chunks.map((chunk, index) => ({
              custom_id: String(index),
              body: { input: chunk.text },
            })),
          });
          return mapBatchEmbeddingsByIndex(byCustomId, batch.chunks.length);
        },
      },
    };
  },
};
