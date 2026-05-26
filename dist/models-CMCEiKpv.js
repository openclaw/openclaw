import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
//#endregion
//#region extensions/deepseek/models.ts
const DEEPSEEK_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
	providerId: "deepseek",
	catalog: {
		"providers": { "deepseek": {
			"baseUrl": "https://api.deepseek.com",
			"api": "openai-completions",
			"models": [
				{
					"id": "deepseek-v4-flash",
					"name": "DeepSeek V4 Flash",
					"reasoning": true,
					"input": ["text"],
					"contextWindow": 1e6,
					"maxTokens": 384e3,
					"cost": {
						"input": .14,
						"output": .28,
						"cacheRead": .028,
						"cacheWrite": 0
					},
					"compat": {
						"supportsUsageInStreaming": true,
						"supportsReasoningEffort": true,
						"maxTokensField": "max_tokens"
					}
				},
				{
					"id": "deepseek-v4-pro",
					"name": "DeepSeek V4 Pro",
					"reasoning": true,
					"input": ["text"],
					"contextWindow": 1e6,
					"maxTokens": 384e3,
					"cost": {
						"input": 1.74,
						"output": 3.48,
						"cacheRead": .145,
						"cacheWrite": 0
					},
					"compat": {
						"supportsUsageInStreaming": true,
						"supportsReasoningEffort": true,
						"maxTokensField": "max_tokens"
					}
				},
				{
					"id": "deepseek-chat",
					"name": "DeepSeek Chat",
					"input": ["text"],
					"contextWindow": 131072,
					"maxTokens": 8192,
					"cost": {
						"input": .28,
						"output": .42,
						"cacheRead": .028,
						"cacheWrite": 0
					},
					"compat": {
						"supportsUsageInStreaming": true,
						"maxTokensField": "max_tokens"
					}
				},
				{
					"id": "deepseek-reasoner",
					"name": "DeepSeek Reasoner",
					"reasoning": true,
					"input": ["text"],
					"contextWindow": 131072,
					"maxTokens": 65536,
					"cost": {
						"input": .28,
						"output": .42,
						"cacheRead": .028,
						"cacheWrite": 0
					},
					"compat": {
						"supportsUsageInStreaming": true,
						"supportsReasoningEffort": false,
						"maxTokensField": "max_tokens"
					}
				}
			]
		} },
		"discovery": { "deepseek": "static" }
	}.providers.deepseek
});
const DEEPSEEK_BASE_URL = DEEPSEEK_MANIFEST_PROVIDER.baseUrl;
const DEEPSEEK_MODEL_CATALOG = DEEPSEEK_MANIFEST_PROVIDER.models;
function buildDeepSeekModelDefinition(model) {
	return {
		...model,
		api: "openai-completions"
	};
}
const DEEPSEEK_V4_MODEL_IDS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
function isDeepSeekV4ModelId(modelId) {
	return DEEPSEEK_V4_MODEL_IDS.has(modelId.toLowerCase());
}
function isDeepSeekV4ModelRef(model) {
	return model.provider === "deepseek" && typeof model.id === "string" && isDeepSeekV4ModelId(model.id);
}
//#endregion
export { isDeepSeekV4ModelRef as a, isDeepSeekV4ModelId as i, DEEPSEEK_MODEL_CATALOG as n, buildDeepSeekModelDefinition as r, DEEPSEEK_BASE_URL as t };
