import { n as resolveRemoteEmbeddingClient, t as createRemoteEmbeddingProvider } from "./memory-core-host-engine-embeddings-KpHOGQkt.js";
import { t as DEEPINFRA_BASE_URL } from "./provider-models-795Y8tc3.js";
import { c as DEFAULT_DEEPINFRA_EMBEDDING_MODEL, g as normalizeDeepInfraModelRef } from "./media-models-NUaU9DZV.js";
//#region extensions/deepinfra/embedding-provider.ts
async function createDeepInfraEmbeddingProvider(options) {
	const client = await resolveRemoteEmbeddingClient({
		provider: "deepinfra",
		options: {
			...options,
			model: normalizeDeepInfraModelRef(options.model, DEFAULT_DEEPINFRA_EMBEDDING_MODEL)
		},
		defaultBaseUrl: DEEPINFRA_BASE_URL,
		normalizeModel: (model) => normalizeDeepInfraModelRef(model, DEFAULT_DEEPINFRA_EMBEDDING_MODEL)
	});
	return {
		provider: createRemoteEmbeddingProvider({
			id: "deepinfra",
			client,
			errorPrefix: "DeepInfra embeddings API error"
		}),
		client
	};
}
//#endregion
export { createDeepInfraEmbeddingProvider as t };
