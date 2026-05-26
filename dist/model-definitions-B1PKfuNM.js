import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
//#region extensions/zai/openclaw.plugin.json
var modelCatalog = {
	"providers": { "zai": {
		"baseUrl": "https://api.z.ai/api/paas/v4",
		"api": "openai-completions",
		"models": [
			{
				"id": "glm-5.1",
				"name": "GLM-5.1",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 202800,
				"maxTokens": 131100,
				"cost": {
					"input": 1.2,
					"output": 4,
					"cacheRead": .24,
					"cacheWrite": 0
				}
			},
			{
				"id": "glm-5",
				"name": "GLM-5",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 202800,
				"maxTokens": 131100,
				"cost": {
					"input": 1,
					"output": 3.2,
					"cacheRead": .2,
					"cacheWrite": 0
				}
			},
			{
				"id": "glm-5-turbo",
				"name": "GLM-5 Turbo",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 202800,
				"maxTokens": 131100,
				"cost": {
					"input": 1.2,
					"output": 4,
					"cacheRead": .24,
					"cacheWrite": 0
				}
			},
			{
				"id": "glm-5v-turbo",
				"name": "GLM-5V Turbo",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 202800,
				"maxTokens": 131100,
				"cost": {
					"input": 1.2,
					"output": 4,
					"cacheRead": .24,
					"cacheWrite": 0
				}
			},
			{
				"id": "glm-4.7",
				"name": "GLM-4.7",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 204800,
				"maxTokens": 131072,
				"cost": {
					"input": .6,
					"output": 2.2,
					"cacheRead": .11,
					"cacheWrite": 0
				}
			},
			{
				"id": "glm-4.7-flash",
				"name": "GLM-4.7 Flash",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 2e5,
				"maxTokens": 131072,
				"cost": {
					"input": .07,
					"output": .4,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			},
			{
				"id": "glm-4.7-flashx",
				"name": "GLM-4.7 FlashX",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 2e5,
				"maxTokens": 128e3,
				"cost": {
					"input": .06,
					"output": .4,
					"cacheRead": .01,
					"cacheWrite": 0
				}
			},
			{
				"id": "glm-4.6",
				"name": "GLM-4.6",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 204800,
				"maxTokens": 131072,
				"cost": {
					"input": .6,
					"output": 2.2,
					"cacheRead": .11,
					"cacheWrite": 0
				}
			},
			{
				"id": "glm-4.6v",
				"name": "GLM-4.6V",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 128e3,
				"maxTokens": 32768,
				"cost": {
					"input": .3,
					"output": .9,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			},
			{
				"id": "glm-4.5",
				"name": "GLM-4.5",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 131072,
				"maxTokens": 98304,
				"cost": {
					"input": .6,
					"output": 2.2,
					"cacheRead": .11,
					"cacheWrite": 0
				}
			},
			{
				"id": "glm-4.5-air",
				"name": "GLM-4.5 Air",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 131072,
				"maxTokens": 98304,
				"cost": {
					"input": .2,
					"output": 1.1,
					"cacheRead": .03,
					"cacheWrite": 0
				}
			},
			{
				"id": "glm-4.5-flash",
				"name": "GLM-4.5 Flash",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 131072,
				"maxTokens": 98304,
				"cost": {
					"input": 0,
					"output": 0,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			},
			{
				"id": "glm-4.5v",
				"name": "GLM-4.5V",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 64e3,
				"maxTokens": 16384,
				"cost": {
					"input": .6,
					"output": 1.8,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			}
		]
	} },
	"discovery": { "zai": "static" }
};
//#endregion
//#region extensions/zai/model-definitions.ts
const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_CODING_CN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const ZAI_GLOBAL_BASE_URL = "https://api.z.ai/api/paas/v4";
const ZAI_CN_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const ZAI_DEFAULT_MODEL_ID = "glm-5.1";
const ZAI_DEFAULT_MODEL_REF = `zai/${ZAI_DEFAULT_MODEL_ID}`;
const ZAI_MANIFEST_CATALOG = modelCatalog.providers.zai;
const ZAI_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
	providerId: "zai",
	catalog: ZAI_MANIFEST_CATALOG
});
const ZAI_MODEL_CATALOG = new Map(ZAI_MANIFEST_PROVIDER.models.map((model) => [model.id, model]));
const ZAI_DEFAULT_COST = ZAI_MODEL_CATALOG.get("glm-5")?.cost ?? {
	input: 1,
	output: 3.2,
	cacheRead: .2,
	cacheWrite: 0
};
function resolveZaiBaseUrl(endpoint) {
	switch (endpoint) {
		case "coding-cn": return ZAI_CODING_CN_BASE_URL;
		case "global": return ZAI_GLOBAL_BASE_URL;
		case "cn": return ZAI_CN_BASE_URL;
		case "coding-global": return ZAI_CODING_GLOBAL_BASE_URL;
		default: return ZAI_GLOBAL_BASE_URL;
	}
}
function buildZaiCatalogModels() {
	return ZAI_MANIFEST_PROVIDER.models.map((model) => Object.assign({}, model, { input: [...model.input] }));
}
function buildZaiModelDefinition(params) {
	const catalog = ZAI_MODEL_CATALOG.get(params.id);
	return {
		id: params.id,
		name: params.name ?? catalog?.name ?? `GLM ${params.id}`,
		reasoning: params.reasoning ?? catalog?.reasoning ?? true,
		input: params.input ?? (catalog?.input ? [...catalog.input] : ["text"]),
		cost: params.cost ?? catalog?.cost ?? ZAI_DEFAULT_COST,
		contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 202800,
		maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 131100
	};
}
//#endregion
export { ZAI_DEFAULT_MODEL_ID as a, buildZaiCatalogModels as c, ZAI_DEFAULT_COST as i, buildZaiModelDefinition as l, ZAI_CODING_CN_BASE_URL as n, ZAI_DEFAULT_MODEL_REF as o, ZAI_CODING_GLOBAL_BASE_URL as r, ZAI_GLOBAL_BASE_URL as s, ZAI_CN_BASE_URL as t, resolveZaiBaseUrl as u };
