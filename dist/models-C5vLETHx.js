import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
//#endregion
//#region extensions/cerebras/models.ts
const CEREBRAS_MANIFEST_CATALOG = {
	"providers": { "cerebras": {
		"baseUrl": "https://api.cerebras.ai/v1",
		"api": "openai-completions",
		"models": [
			{
				"id": "zai-glm-4.7",
				"name": "Z.ai GLM 4.7",
				"input": ["text"],
				"reasoning": true,
				"contextWindow": 128e3,
				"maxTokens": 8192,
				"cost": {
					"input": 2.25,
					"output": 2.75,
					"cacheRead": 2.25,
					"cacheWrite": 2.75
				}
			},
			{
				"id": "gpt-oss-120b",
				"name": "GPT OSS 120B",
				"input": ["text"],
				"reasoning": true,
				"contextWindow": 128e3,
				"maxTokens": 8192,
				"cost": {
					"input": .35,
					"output": .75,
					"cacheRead": .35,
					"cacheWrite": .75
				}
			},
			{
				"id": "qwen-3-235b-a22b-instruct-2507",
				"name": "Qwen 3 235B Instruct",
				"input": ["text"],
				"contextWindow": 128e3,
				"maxTokens": 8192,
				"cost": {
					"input": .6,
					"output": 1.2,
					"cacheRead": .6,
					"cacheWrite": 1.2
				}
			},
			{
				"id": "llama3.1-8b",
				"name": "Llama 3.1 8B",
				"input": ["text"],
				"contextWindow": 128e3,
				"maxTokens": 8192,
				"cost": {
					"input": .1,
					"output": .1,
					"cacheRead": .1,
					"cacheWrite": .1
				}
			}
		]
	} },
	"discovery": { "cerebras": "static" }
}.providers.cerebras;
const CEREBRAS_BASE_URL = CEREBRAS_MANIFEST_CATALOG.baseUrl;
const CEREBRAS_MODEL_CATALOG = CEREBRAS_MANIFEST_CATALOG.models;
function buildCerebrasCatalogModels() {
	return buildManifestModelProviderConfig({
		providerId: "cerebras",
		catalog: CEREBRAS_MANIFEST_CATALOG
	}).models;
}
function buildCerebrasModelDefinition(model) {
	return buildManifestModelProviderConfig({
		providerId: "cerebras",
		catalog: {
			...CEREBRAS_MANIFEST_CATALOG,
			models: [model]
		}
	}).models[0];
}
//#endregion
export { buildCerebrasModelDefinition as i, CEREBRAS_MODEL_CATALOG as n, buildCerebrasCatalogModels as r, CEREBRAS_BASE_URL as t };
