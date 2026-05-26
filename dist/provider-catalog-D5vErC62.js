import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
//#region extensions/nvidia/openclaw.plugin.json
var modelCatalog = {
	"providers": { "nvidia": {
		"baseUrl": "https://integrate.api.nvidia.com/v1",
		"api": "openai-completions",
		"models": [
			{
				"id": "nvidia/nemotron-3-super-120b-a12b",
				"name": "NVIDIA Nemotron 3 Super 120B",
				"input": ["text"],
				"contextWindow": 262144,
				"maxTokens": 8192,
				"cost": {
					"input": 0,
					"output": 0,
					"cacheRead": 0,
					"cacheWrite": 0
				},
				"compat": { "requiresStringContent": true }
			},
			{
				"id": "moonshotai/kimi-k2.5",
				"name": "Kimi K2.5",
				"input": ["text"],
				"contextWindow": 262144,
				"maxTokens": 8192,
				"cost": {
					"input": 0,
					"output": 0,
					"cacheRead": 0,
					"cacheWrite": 0
				},
				"compat": { "requiresStringContent": true }
			},
			{
				"id": "minimaxai/minimax-m2.5",
				"name": "MiniMax M2.5",
				"input": ["text"],
				"contextWindow": 196608,
				"maxTokens": 8192,
				"cost": {
					"input": 0,
					"output": 0,
					"cacheRead": 0,
					"cacheWrite": 0
				},
				"compat": { "requiresStringContent": true }
			},
			{
				"id": "z-ai/glm5",
				"name": "GLM-5",
				"input": ["text"],
				"contextWindow": 202752,
				"maxTokens": 8192,
				"cost": {
					"input": 0,
					"output": 0,
					"cacheRead": 0,
					"cacheWrite": 0
				},
				"compat": { "requiresStringContent": true }
			}
		]
	} },
	"discovery": { "nvidia": "static" }
};
//#endregion
//#region extensions/nvidia/provider-catalog.ts
const NVIDIA_DEFAULT_MODEL_ID = "nvidia/nemotron-3-super-120b-a12b";
function buildNvidiaProvider() {
	return {
		...buildManifestModelProviderConfig({
			providerId: "nvidia",
			catalog: modelCatalog.providers.nvidia
		}),
		apiKey: "NVIDIA_API_KEY"
	};
}
//#endregion
export { buildNvidiaProvider as n, NVIDIA_DEFAULT_MODEL_ID as t };
