import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
//#region extensions/tencent/openclaw.plugin.json
var modelCatalog = {
	"providers": { "tencent-tokenhub": {
		"baseUrl": "https://tokenhub.tencentmaas.com/v1",
		"api": "openai-completions",
		"models": [{
			"id": "hy3-preview",
			"name": "Hy3 preview (TokenHub)",
			"reasoning": true,
			"input": ["text"],
			"contextWindow": 256e3,
			"maxTokens": 64e3,
			"cost": {
				"input": .176,
				"output": .587,
				"cacheRead": .059,
				"cacheWrite": 0,
				"tieredPricing": [
					{
						"input": .176,
						"output": .587,
						"cacheRead": .059,
						"cacheWrite": 0,
						"range": [0, 16e3]
					},
					{
						"input": .235,
						"output": .939,
						"cacheRead": .088,
						"cacheWrite": 0,
						"range": [16e3, 32e3]
					},
					{
						"input": .293,
						"output": 1.173,
						"cacheRead": .117,
						"cacheWrite": 0,
						"range": [32e3]
					}
				]
			},
			"compat": {
				"supportsUsageInStreaming": true,
				"supportsReasoningEffort": true
			}
		}]
	} },
	"discovery": { "tencent-tokenhub": "static" }
};
//#endregion
//#region extensions/tencent/models.ts
const TOKENHUB_PROVIDER_ID = "tencent-tokenhub";
const TOKENHUB_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
	providerId: TOKENHUB_PROVIDER_ID,
	catalog: modelCatalog.providers[TOKENHUB_PROVIDER_ID]
});
const TOKENHUB_BASE_URL = TOKENHUB_MANIFEST_PROVIDER.baseUrl;
const TOKENHUB_MODEL_CATALOG = TOKENHUB_MANIFEST_PROVIDER.models;
function buildTokenHubModelDefinition(model) {
	return {
		...model,
		api: "openai-completions"
	};
}
//#endregion
export { buildTokenHubModelDefinition as i, TOKENHUB_MODEL_CATALOG as n, TOKENHUB_PROVIDER_ID as r, TOKENHUB_BASE_URL as t };
