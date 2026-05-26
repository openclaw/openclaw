import { c as mapBatchEmbeddingsByIndex, l as sanitizeEmbeddingCacheHeaders, s as isMissingEmbeddingApiKeyError } from "./memory-core-host-engine-embeddings-C9DVPPfR.js";
import { t as runVoyageEmbeddingBatches } from "./embedding-batch-EwDreDe4.js";
import { n as createVoyageEmbeddingProvider, t as DEFAULT_VOYAGE_EMBEDDING_MODEL } from "./embedding-provider-CW55tz0c.js";
//#region extensions/voyage/memory-embedding-adapter.ts
const voyageMemoryEmbeddingProviderAdapter = {
	id: "voyage",
	defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
	transport: "remote",
	authProviderId: "voyage",
	autoSelectPriority: 40,
	allowExplicitWhenConfiguredAuto: true,
	shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
	create: async (options) => {
		const { provider, client } = await createVoyageEmbeddingProvider({
			...options,
			provider: "voyage",
			fallback: "none"
		});
		return {
			provider,
			runtime: {
				id: "voyage",
				cacheKeyData: {
					provider: "voyage",
					baseUrl: client.baseUrl,
					model: client.model,
					headers: sanitizeEmbeddingCacheHeaders(client.headers, ["authorization"])
				},
				batchEmbed: async (batch) => {
					return mapBatchEmbeddingsByIndex(await runVoyageEmbeddingBatches({
						client,
						agentId: batch.agentId,
						requests: batch.chunks.map((chunk, index) => ({
							custom_id: String(index),
							body: { input: chunk.text }
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
export { voyageMemoryEmbeddingProviderAdapter as t };
