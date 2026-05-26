import { s as isMissingEmbeddingApiKeyError } from "./memory-core-host-engine-embeddings-C9DVPPfR.js";
import { c as DEFAULT_DEEPINFRA_EMBEDDING_MODEL } from "./media-models-Dp3VJEzX.js";
import { t as createDeepInfraEmbeddingProvider } from "./embedding-provider-cMy5KyDl.js";
//#region extensions/deepinfra/memory-embedding-adapter.ts
const deepinfraMemoryEmbeddingProviderAdapter = {
	id: "deepinfra",
	defaultModel: DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
	transport: "remote",
	authProviderId: "deepinfra",
	autoSelectPriority: 55,
	allowExplicitWhenConfiguredAuto: true,
	shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
	create: async (options) => {
		const { provider, client } = await createDeepInfraEmbeddingProvider({
			...options,
			provider: "deepinfra",
			fallback: "none"
		});
		return {
			provider,
			runtime: {
				id: "deepinfra",
				cacheKeyData: {
					provider: "deepinfra",
					model: client.model
				}
			}
		};
	}
};
//#endregion
export { deepinfraMemoryEmbeddingProviderAdapter as t };
