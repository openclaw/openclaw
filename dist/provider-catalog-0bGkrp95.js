import { n as buildManifestModelProviderConfig, o as supportsNativeStreamingUsageCompat, t as applyProviderNativeStreamingUsageCompat } from "./provider-catalog-shared-BLp5nwNN.js";
//#region extensions/moonshot/openclaw.plugin.json
var modelCatalog = {
	"aliases": {
		"moonshotai": { "provider": "moonshot" },
		"moonshot-ai": { "provider": "moonshot" }
	},
	"providers": { "moonshot": {
		"baseUrl": "https://api.moonshot.ai/v1",
		"api": "openai-completions",
		"models": [
			{
				"id": "kimi-k2.6",
				"name": "Kimi K2.6",
				"input": ["text", "image"],
				"contextWindow": 262144,
				"maxTokens": 262144,
				"cost": {
					"input": .95,
					"output": 4,
					"cacheRead": .16,
					"cacheWrite": 0
				}
			},
			{
				"id": "kimi-k2.5",
				"name": "Kimi K2.5",
				"input": ["text", "image"],
				"contextWindow": 262144,
				"maxTokens": 262144,
				"cost": {
					"input": .6,
					"output": 3,
					"cacheRead": .1,
					"cacheWrite": 0
				}
			},
			{
				"id": "kimi-k2-thinking",
				"name": "Kimi K2 Thinking",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 262144,
				"maxTokens": 262144,
				"cost": {
					"input": 0,
					"output": 0,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			},
			{
				"id": "kimi-k2-thinking-turbo",
				"name": "Kimi K2 Thinking Turbo",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 262144,
				"maxTokens": 262144,
				"cost": {
					"input": 0,
					"output": 0,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			},
			{
				"id": "kimi-k2-turbo",
				"name": "Kimi K2 Turbo",
				"input": ["text"],
				"contextWindow": 256e3,
				"maxTokens": 16384,
				"cost": {
					"input": 0,
					"output": 0,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			}
		]
	} },
	"discovery": { "moonshot": "static" }
};
//#endregion
//#region extensions/moonshot/provider-catalog.ts
const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";
const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.6";
function isNativeMoonshotBaseUrl(baseUrl) {
	return supportsNativeStreamingUsageCompat({
		providerId: "moonshot",
		baseUrl
	});
}
function applyMoonshotNativeStreamingUsageCompat(provider) {
	return applyProviderNativeStreamingUsageCompat({
		providerId: "moonshot",
		providerConfig: provider
	});
}
function buildMoonshotProvider() {
	return buildManifestModelProviderConfig({
		providerId: "moonshot",
		catalog: modelCatalog.providers.moonshot
	});
}
//#endregion
export { buildMoonshotProvider as a, applyMoonshotNativeStreamingUsageCompat as i, MOONSHOT_CN_BASE_URL as n, isNativeMoonshotBaseUrl as o, MOONSHOT_DEFAULT_MODEL_ID as r, MOONSHOT_BASE_URL as t };
