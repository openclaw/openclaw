import { n as applyAgentDefaultModelPrimary, u as applyProviderConfigWithModelCatalogPreset } from "./provider-onboard-MLXAQX8H.js";
import { a as buildChutesModelDefinition, i as CHUTES_MODEL_CATALOG, r as CHUTES_DEFAULT_MODEL_REF, t as CHUTES_BASE_URL } from "./models-DkGbHMZb.js";
//#region extensions/chutes/onboard.ts
/**
* Apply Chutes provider configuration without changing the default model.
* Registers all catalog models and sets provider aliases (chutes-fast, etc.).
*/
function applyChutesProviderConfig(cfg) {
	return applyProviderConfigWithModelCatalogPreset(cfg, {
		providerId: "chutes",
		api: "openai-completions",
		baseUrl: CHUTES_BASE_URL,
		catalogModels: CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition),
		aliases: [
			...CHUTES_MODEL_CATALOG.map((model) => `chutes/${model.id}`),
			{
				modelRef: "chutes-fast",
				alias: "chutes/zai-org/GLM-4.7-FP8"
			},
			{
				modelRef: "chutes-vision",
				alias: "chutes/chutesai/Mistral-Small-3.2-24B-Instruct-2506"
			},
			{
				modelRef: "chutes-pro",
				alias: "chutes/deepseek-ai/DeepSeek-V3.2-TEE"
			}
		]
	});
}
/**
* Apply Chutes provider configuration AND set Chutes as the default model.
*/
function applyChutesConfig(cfg) {
	const next = applyChutesProviderConfig(cfg);
	return {
		...next,
		agents: {
			...next.agents,
			defaults: {
				...next.agents?.defaults,
				model: {
					primary: CHUTES_DEFAULT_MODEL_REF,
					fallbacks: ["chutes/deepseek-ai/DeepSeek-V3.2-TEE", "chutes/Qwen/Qwen3-32B"]
				},
				imageModel: {
					primary: "chutes/chutesai/Mistral-Small-3.2-24B-Instruct-2506",
					fallbacks: ["chutes/chutesai/Mistral-Small-3.1-24B-Instruct-2503"]
				}
			}
		}
	};
}
function applyChutesApiKeyConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyChutesProviderConfig(cfg), CHUTES_DEFAULT_MODEL_REF);
}
//#endregion
export { applyChutesConfig as n, applyChutesProviderConfig as r, applyChutesApiKeyConfig as t };
