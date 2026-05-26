import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
//#region extensions/xiaomi/openclaw.plugin.json
var modelCatalog = {
	"providers": { "xiaomi": {
		"baseUrl": "https://api.xiaomimimo.com/v1",
		"api": "openai-completions",
		"models": [
			{
				"id": "mimo-v2-flash",
				"name": "Xiaomi MiMo V2 Flash",
				"input": ["text"],
				"contextWindow": 262144,
				"maxTokens": 8192,
				"cost": {
					"input": 0,
					"output": 0,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			},
			{
				"id": "mimo-v2-pro",
				"name": "Xiaomi MiMo V2 Pro",
				"input": ["text"],
				"reasoning": true,
				"contextWindow": 1048576,
				"maxTokens": 32e3,
				"cost": {
					"input": 0,
					"output": 0,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			},
			{
				"id": "mimo-v2-omni",
				"name": "Xiaomi MiMo V2 Omni",
				"input": ["text", "image"],
				"reasoning": true,
				"contextWindow": 262144,
				"maxTokens": 32e3,
				"cost": {
					"input": 0,
					"output": 0,
					"cacheRead": 0,
					"cacheWrite": 0
				}
			}
		]
	} },
	"discovery": { "xiaomi": "static" }
};
//#endregion
//#region extensions/xiaomi/provider-catalog.ts
const XIAOMI_DEFAULT_MODEL_ID = "mimo-v2-flash";
function buildXiaomiProvider() {
	return buildManifestModelProviderConfig({
		providerId: "xiaomi",
		catalog: modelCatalog.providers.xiaomi
	});
}
//#endregion
export { buildXiaomiProvider as n, XIAOMI_DEFAULT_MODEL_ID as t };
