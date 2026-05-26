import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
//#region extensions/qianfan/openclaw.plugin.json
var modelCatalog = {
	"providers": { "qianfan": {
		"baseUrl": "https://qianfan.baidubce.com/v2",
		"api": "openai-completions",
		"models": [{
			"id": "deepseek-v3.2",
			"name": "DEEPSEEK V3.2",
			"input": ["text"],
			"reasoning": true,
			"contextWindow": 98304,
			"maxTokens": 32768,
			"cost": {
				"input": 0,
				"output": 0,
				"cacheRead": 0,
				"cacheWrite": 0
			}
		}, {
			"id": "ernie-5.0-thinking-preview",
			"name": "ERNIE-5.0-Thinking-Preview",
			"input": ["text", "image"],
			"reasoning": true,
			"contextWindow": 119e3,
			"maxTokens": 64e3,
			"cost": {
				"input": 0,
				"output": 0,
				"cacheRead": 0,
				"cacheWrite": 0
			}
		}]
	} },
	"discovery": { "qianfan": "static" }
};
//#endregion
//#region extensions/qianfan/provider-catalog.ts
const QIANFAN_BASE_URL = "https://qianfan.baidubce.com/v2";
const QIANFAN_DEFAULT_MODEL_ID = "deepseek-v3.2";
function buildQianfanProvider() {
	return buildManifestModelProviderConfig({
		providerId: "qianfan",
		catalog: modelCatalog.providers.qianfan
	});
}
//#endregion
export { QIANFAN_DEFAULT_MODEL_ID as n, buildQianfanProvider as r, QIANFAN_BASE_URL as t };
