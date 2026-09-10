// Google plugin module implements memory embedding adapter behavior.
import {
  hasNonTextEmbeddingParts,
  isMissingEmbeddingApiKeyError,
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { runGeminiEmbeddingBatches } from "./embedding-batch.js";
import {
  buildGeminiEmbeddingRequest,
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  isGeminiEmbedding2Model,
} from "./embedding-provider.js";

export const geminiMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "gemini",
  defaultModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "google",
  autoSelectPriority: 30,
  allowExplicitWhenConfiguredAuto: true,
  supportsMultimodalEmbeddings: ({ model }) => isGeminiEmbedding2Model(model),
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    const { provider, client } = await createGeminiEmbeddingProvider({
      ...options,
      provider: "gemini",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "gemini",
        cacheKeyData: {
          provider: "gemini",
          baseUrl: client.baseUrl,
          model: client.model,
          outputDimensionality: client.outputDimensionality,
          // x-goog-api-client is generated partner attribution (openclaw/<version>).
          // Keep it on outbound requests, but exclude it from durable memory identity so
          // OpenClaw version bumps do not pause otherwise-compatible Gemini indexes.
          headers: sanitizeEmbeddingCacheHeaders(client.headers, [
            "authorization",
            "x-goog-api-key",
            "x-goog-api-client",
          ]),
        },
        batchFailureMode: "error",
        batchEmbed: async (batch) => {
          if (batch.chunks.some((chunk) => hasNonTextEmbeddingParts(chunk.embeddingInput))) {
            return null;
          }
          if (batch.chunks.some((chunk) => !chunk.hash)) {
            throw new Error("gemini native batch requires stable memory chunk hashes");
          }
          // SAFETY: the preceding guard proves every chunk in this batch has a non-empty hash.
          const uniqueChunks = new Map(batch.chunks.map((chunk) => [chunk.hash as string, chunk]));
          const byCustomId = await runGeminiEmbeddingBatches({
            gemini: client,
            agentId: batch.agentId,
            requests: [...uniqueChunks].map(([chunkHash, chunk]) => ({
              custom_id: chunkHash,
              chunkHash,
              request: buildGeminiEmbeddingRequest({
                input: chunk.embeddingInput ?? { text: chunk.text },
                model: client.model,
                role: "document",
                taskType: "RETRIEVAL_DOCUMENT",
                modelPath: client.modelPath,
                outputDimensionality: client.outputDimensionality,
              }),
            })),
            wait: batch.wait,
            concurrency: batch.concurrency,
            pollIntervalMs: batch.pollIntervalMs,
            timeoutMs: batch.timeoutMs,
            debug: batch.debug,
            ...(batch.signal ? { signal: batch.signal } : {}),
            ...(batch.submissionLifecycle
              ? { submissionLifecycle: batch.submissionLifecycle }
              : {}),
          });
          // SAFETY: the same all-chunk hash guard remains valid for this unchanged batch array.
          return batch.chunks.map((chunk) => byCustomId.get(chunk.hash as string) ?? []);
        },
      },
    };
  },
};
