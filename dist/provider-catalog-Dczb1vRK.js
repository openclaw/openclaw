import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
//#region extensions/fireworks/openclaw.plugin.json
var modelCatalog = {
	"providers": { "fireworks": {
		"baseUrl": "https://api.fireworks.ai/inference/v1",
		"api": "openai-completions",
		"models": [{
			"id": "accounts/fireworks/models/kimi-k2p6",
			"name": "Kimi K2.6",
			"input": ["text", "image"],
			"contextWindow": 262144,
			"maxTokens": 262144,
			"cost": {
				"input": .95,
				"output": 4,
				"cacheRead": 0,
				"cacheWrite": 0
			}
		}, {
			"id": "accounts/fireworks/routers/kimi-k2p5-turbo",
			"name": "Kimi K2.5 Turbo (Fire Pass)",
			"input": ["text", "image"],
			"contextWindow": 256e3,
			"maxTokens": 256e3,
			"compat": { "unsupportedToolSchemaKeywords": ["not"] },
			"cost": {
				"input": 0,
				"output": 0,
				"cacheRead": 0,
				"cacheWrite": 0
			}
		}]
	} },
	"discovery": { "fireworks": "static" }
};
//#endregion
//#region extensions/fireworks/provider-catalog.ts
const FIREWORKS_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
	providerId: "fireworks",
	catalog: modelCatalog.providers.fireworks
});
const FIREWORKS_BASE_URL = FIREWORKS_MANIFEST_PROVIDER.baseUrl;
const FIREWORKS_DEFAULT_MODEL_ID = "accounts/fireworks/routers/kimi-k2p5-turbo";
const FIREWORKS_K2_6_MODEL_ID = "accounts/fireworks/models/kimi-k2p6";
function requireFireworksManifestModel(id) {
	const model = FIREWORKS_MANIFEST_PROVIDER.models.find((entry) => entry.id === id);
	if (!model) throw new Error(`Missing Fireworks modelCatalog row ${id}`);
	return model;
}
const FIREWORKS_DEFAULT_MODEL = requireFireworksManifestModel(FIREWORKS_DEFAULT_MODEL_ID);
const FIREWORKS_K2_6_MODEL = requireFireworksManifestModel(FIREWORKS_K2_6_MODEL_ID);
const FIREWORKS_DEFAULT_CONTEXT_WINDOW = FIREWORKS_DEFAULT_MODEL.contextWindow;
const FIREWORKS_DEFAULT_MAX_TOKENS = FIREWORKS_DEFAULT_MODEL.maxTokens;
const FIREWORKS_K2_6_CONTEXT_WINDOW = FIREWORKS_K2_6_MODEL.contextWindow;
const FIREWORKS_K2_6_MAX_TOKENS = FIREWORKS_K2_6_MODEL.maxTokens;
function cloneFireworksCatalogModel(model) {
	return {
		...model,
		input: [...model.input],
		cost: { ...model.cost }
	};
}
function buildFireworksCatalogModels() {
	return FIREWORKS_MANIFEST_PROVIDER.models.map(cloneFireworksCatalogModel);
}
function buildFireworksProvider() {
	return buildManifestModelProviderConfig({
		providerId: "fireworks",
		catalog: modelCatalog.providers.fireworks
	});
}
//#endregion
export { FIREWORKS_K2_6_CONTEXT_WINDOW as a, buildFireworksCatalogModels as c, FIREWORKS_DEFAULT_MODEL_ID as i, buildFireworksProvider as l, FIREWORKS_DEFAULT_CONTEXT_WINDOW as n, FIREWORKS_K2_6_MAX_TOKENS as o, FIREWORKS_DEFAULT_MAX_TOKENS as r, FIREWORKS_K2_6_MODEL_ID as s, FIREWORKS_BASE_URL as t };
