import { a as normalizeEmbeddingModelWithPrefixes, i as resolveRemoteEmbeddingBearerClient, r as fetchRemoteEmbeddingVectors } from "./memory-core-host-engine-embeddings-B41PUaLw.js";
//#region extensions/voyage/embedding-provider.ts
const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-4-large";
const DEFAULT_VOYAGE_BASE_URL = "https://api.voyageai.com/v1";
const VOYAGE_MAX_INPUT_TOKENS = {
	"voyage-3": 32e3,
	"voyage-3-lite": 16e3,
	"voyage-code-3": 32e3
};
function normalizeVoyageModel(model) {
	return normalizeEmbeddingModelWithPrefixes({
		model,
		defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
		prefixes: ["voyage/"]
	});
}
async function createVoyageEmbeddingProvider(options) {
	const client = await resolveVoyageEmbeddingClient(options);
	const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;
	const embed = async (input, input_type) => {
		if (input.length === 0) return [];
		const body = {
			model: client.model,
			input
		};
		if (input_type) body.input_type = input_type;
		return await fetchRemoteEmbeddingVectors({
			url,
			headers: client.headers,
			ssrfPolicy: client.ssrfPolicy,
			body,
			errorPrefix: "voyage embeddings failed"
		});
	};
	return {
		provider: {
			id: "voyage",
			model: client.model,
			maxInputTokens: VOYAGE_MAX_INPUT_TOKENS[client.model],
			embedQuery: async (text) => {
				const [vec] = await embed([text], "query");
				return vec ?? [];
			},
			embedBatch: async (texts) => embed(texts, "document")
		},
		client
	};
}
async function resolveVoyageEmbeddingClient(options) {
	const { baseUrl, headers, ssrfPolicy } = await resolveRemoteEmbeddingBearerClient({
		provider: "voyage",
		options,
		defaultBaseUrl: DEFAULT_VOYAGE_BASE_URL
	});
	return {
		baseUrl,
		headers,
		ssrfPolicy,
		model: normalizeVoyageModel(options.model)
	};
}
//#endregion
export { createVoyageEmbeddingProvider as n, DEFAULT_VOYAGE_EMBEDDING_MODEL as t };
