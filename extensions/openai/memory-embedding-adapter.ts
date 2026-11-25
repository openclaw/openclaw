import {
  mapBatchEmbeddingsByIndex,
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/embedding-provider-adapter";
import { OPENAI_DEFAULT_EMBEDDING_MODEL } from "./default-models.js";

function resolveEmbeddingCacheExcludedHeaders(providerId: string, baseUrl: string): string[] {
  const excludedHeaders = ["authorization", "x-api-key", "api-key"];
  if (providerId !== "openai") {
    return excludedHeaders;
  }
  if (URL.parse(baseUrl)?.hostname.toLowerCase().replace(/\.+$/, "") === "api.openai.com") {
    // Native attribution changes on every upgrade; cache identity must describe embeddings,
    // not the OpenClaw build that requested them.
    excludedHeaders.push("version", "user-agent");
  }
  return excludedHeaders;
}

export const openAiMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "openai",
  defaultModel: OPENAI_DEFAULT_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "openai",
  autoSelectPriority: 20,
  create: async (options) => {
    const resolvedProvider = options.provider ?? "openai";
    const { createOpenAiEmbeddingProvider } = await import("./embedding-provider.js");
    const { provider, client } = await createOpenAiEmbeddingProvider({
      ...options,
      provider: resolvedProvider,
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "openai",
        sourceWideBatchEmbed: true,
        cacheKeyData: {
          provider: resolvedProvider,
          baseUrl: client.baseUrl,
          model: client.model,
          outputDimensionality: client.outputDimensionality,
          documentInputType: client.documentInputType ?? client.inputType,
          headers: sanitizeEmbeddingCacheHeaders(
            client.headers,
            resolveEmbeddingCacheExcludedHeaders(resolvedProvider, client.baseUrl),
          ),
        },
        batchEmbed: async (batch) => {
          const inputType = client.documentInputType ?? client.inputType;
          const { OPENAI_BATCH_ENDPOINT, runOpenAiEmbeddingBatches } =
            await import("./embedding-batch.js");
          const byCustomId = await runOpenAiEmbeddingBatches({
            ...batch,
            openAi: client,
            requests: batch.chunks.map((chunk, index) => ({
              custom_id: String(index),
              method: "POST",
              url: OPENAI_BATCH_ENDPOINT,
              body: {
                model: client.model,
                input: chunk.text,
                ...(client.outputDimensionality !== undefined
                  ? { dimensions: client.outputDimensionality }
                  : {}),
                ...(inputType ? { input_type: inputType } : {}),
              },
            })),
          });
          return mapBatchEmbeddingsByIndex(byCustomId, batch.chunks.length);
        },
      },
    };
  },
};
