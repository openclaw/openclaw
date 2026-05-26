import { a as normalizeEmbeddingModelWithPrefixes, n as resolveRemoteEmbeddingClient, t as createRemoteEmbeddingProvider } from "./memory-core-host-engine-embeddings-C9DVPPfR.js";
//#region extensions/mistral/embedding-provider.ts
const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";
const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
function normalizeMistralModel(model) {
	return normalizeEmbeddingModelWithPrefixes({
		model,
		defaultModel: DEFAULT_MISTRAL_EMBEDDING_MODEL,
		prefixes: ["mistral/"]
	});
}
async function createMistralEmbeddingProvider(options) {
	const client = await resolveMistralEmbeddingClient(options);
	return {
		provider: createRemoteEmbeddingProvider({
			id: "mistral",
			client,
			errorPrefix: "mistral embeddings failed"
		}),
		client
	};
}
async function resolveMistralEmbeddingClient(options) {
	return await resolveRemoteEmbeddingClient({
		provider: "mistral",
		options,
		defaultBaseUrl: DEFAULT_MISTRAL_BASE_URL,
		normalizeModel: normalizeMistralModel
	});
}
//#endregion
export { createMistralEmbeddingProvider as n, DEFAULT_MISTRAL_EMBEDDING_MODEL as t };
