import {
  isMissingEmbeddingApiKeyError,
  mapBatchEmbeddingsByIndex,
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { OPENAI_BATCH_ENDPOINT, runOpenAiEmbeddingBatches } from "./embedding-batch.js";
import {
  createOpenAiEmbeddingProvider,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
} from "./embedding-provider.js";

export const openAiMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "openai",
  defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "openai",
  autoSelectPriority: 20,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    // Preserve the caller's custom provider ID (e.g. `bailian-embedding`)
    // so the downstream remote-client resolves `models.providers[<id>]` for
    // its `baseUrl`, API key, and headers. Forcing `"openai"` here dropped
    // that custom ID and routed every memory-embedding call back at the
    // default OpenAI endpoint with OpenAI auth, which is what made
    // `bailian-embedding` (and every other OpenAI-compatible custom
    // provider) fail with `fetch failed`. See #47884. The adapter id
    // itself stays `"openai"` — only the *provider-config lookup key* is
    // preserved.
    const resolvedProviderId = options.provider ?? "openai";
    const { provider, client } = await createOpenAiEmbeddingProvider({
      ...options,
      provider: resolvedProviderId,
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "openai",
        cacheKeyData: {
          provider: resolvedProviderId,
          baseUrl: client.baseUrl,
          model: client.model,
          outputDimensionality: client.outputDimensionality,
          documentInputType: client.documentInputType ?? client.inputType,
          headers: sanitizeEmbeddingCacheHeaders(client.headers, ["authorization"]),
        },
        batchEmbed: async (batch) => {
          const inputType = client.documentInputType ?? client.inputType;
          const byCustomId = await runOpenAiEmbeddingBatches({
            openAi: client,
            agentId: batch.agentId,
            requests: batch.chunks.map((chunk, index) => ({
              custom_id: String(index),
              method: "POST",
              url: OPENAI_BATCH_ENDPOINT,
              body: {
                model: client.model,
                input: chunk.text,
                ...(typeof client.outputDimensionality === "number"
                  ? { dimensions: client.outputDimensionality }
                  : {}),
                ...(inputType ? { input_type: inputType } : {}),
              },
            })),
            wait: batch.wait,
            concurrency: batch.concurrency,
            pollIntervalMs: batch.pollIntervalMs,
            timeoutMs: batch.timeoutMs,
            debug: batch.debug,
          });
          return mapBatchEmbeddingsByIndex(byCustomId, batch.chunks.length);
        },
      },
    };
  },
};
