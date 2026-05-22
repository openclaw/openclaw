import { s as isMissingEmbeddingApiKeyError } from "./memory-core-host-engine-embeddings-BIzDx1Xf.js";
import { n as createBedrockEmbeddingProvider, r as hasAwsCredentials, t as DEFAULT_BEDROCK_EMBEDDING_MODEL } from "./embedding-provider-BnnLW76G.js";
//#region extensions/amazon-bedrock/memory-embedding-adapter.ts
const bedrockMemoryEmbeddingProviderAdapter = {
	id: "bedrock",
	defaultModel: DEFAULT_BEDROCK_EMBEDDING_MODEL,
	transport: "remote",
	authProviderId: "amazon-bedrock",
	autoSelectPriority: 60,
	allowExplicitWhenConfiguredAuto: true,
	shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
	create: async (options) => {
		if (!await hasAwsCredentials()) throw new Error("No API key found for provider \"bedrock\". AWS credentials are not available. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or AWS_BEARER_TOKEN_BEDROCK, configure an EC2/ECS/EKS role, or set agents.defaults.memorySearch.provider to another provider.");
		const { provider, client } = await createBedrockEmbeddingProvider({
			...options,
			provider: "bedrock",
			fallback: "none"
		});
		return {
			provider,
			runtime: {
				id: "bedrock",
				cacheKeyData: {
					provider: "bedrock",
					region: client.region,
					model: client.model,
					dimensions: client.dimensions
				}
			}
		};
	}
};
//#endregion
export { bedrockMemoryEmbeddingProviderAdapter as t };
