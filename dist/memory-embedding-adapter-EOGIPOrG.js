import { c as mapBatchEmbeddingsByIndex, l as sanitizeEmbeddingCacheHeaders, s as isMissingEmbeddingApiKeyError } from "./memory-core-host-engine-embeddings-C9DVPPfR.js";
import { r as runOpenAiEmbeddingBatches, t as OPENAI_BATCH_ENDPOINT } from "./embedding-batch-CHvsZDZy.js";
import { n as createOpenAiEmbeddingProvider, t as DEFAULT_OPENAI_EMBEDDING_MODEL } from "./embedding-provider-BgJGcK_N.js";
//#region extensions/openai/memory-embedding-adapter.ts
const openAiMemoryEmbeddingProviderAdapter = {
	id: "openai",
	defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
	transport: "remote",
	authProviderId: "openai",
	autoSelectPriority: 20,
	allowExplicitWhenConfiguredAuto: true,
	shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
	create: async (options) => {
		const { provider, client } = await createOpenAiEmbeddingProvider({
			...options,
			provider: "openai",
			fallback: "none"
		});
		return {
			provider,
			runtime: {
				id: "openai",
				cacheKeyData: {
					provider: "openai",
					baseUrl: client.baseUrl,
					model: client.model,
					outputDimensionality: client.outputDimensionality,
					documentInputType: client.documentInputType ?? client.inputType,
					headers: sanitizeEmbeddingCacheHeaders(client.headers, ["authorization"])
				},
				batchEmbed: async (batch) => {
					const inputType = client.documentInputType ?? client.inputType;
					return mapBatchEmbeddingsByIndex(await runOpenAiEmbeddingBatches({
						openAi: client,
						agentId: batch.agentId,
						requests: batch.chunks.map((chunk, index) => ({
							custom_id: String(index),
							method: "POST",
							url: OPENAI_BATCH_ENDPOINT,
							body: {
								model: client.model,
								input: chunk.text,
								...typeof client.outputDimensionality === "number" ? { dimensions: client.outputDimensionality } : {},
								...inputType ? { input_type: inputType } : {}
							}
						})),
						wait: batch.wait,
						concurrency: batch.concurrency,
						pollIntervalMs: batch.pollIntervalMs,
						timeoutMs: batch.timeoutMs,
						debug: batch.debug
					}), batch.chunks.length);
				}
			}
		};
	}
};
//#endregion
export { openAiMemoryEmbeddingProviderAdapter as t };
