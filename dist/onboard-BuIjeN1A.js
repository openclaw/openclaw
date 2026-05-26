import { p as createModelCatalogPresetAppliers } from "./provider-onboard-MLXAQX8H.js";
import { a as XAI_DEFAULT_MODEL_ID, c as buildXaiCatalogModels, t as XAI_BASE_URL, u as isRetiredXaiBuiltinModelId } from "./model-definitions-hd9WbvLm.js";
//#region extensions/xai/onboard.ts
const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;
const xaiPresetAppliers = createModelCatalogPresetAppliers({
	primaryModelRef: XAI_DEFAULT_MODEL_REF,
	resolveParams: (_cfg, api) => ({
		providerId: "xai",
		api,
		baseUrl: XAI_BASE_URL,
		catalogModels: buildXaiCatalogModels(),
		aliases: [{
			modelRef: XAI_DEFAULT_MODEL_REF,
			alias: "Grok"
		}]
	})
});
function pruneRetiredXaiBuiltinModels(cfg) {
	const provider = cfg.models?.providers?.xai;
	if (!provider || !Array.isArray(provider.models)) return cfg;
	const models = provider.models.filter((model) => !isRetiredXaiBuiltinModelId(model.id));
	if (models.length === provider.models.length) return cfg;
	return {
		...cfg,
		models: {
			...cfg.models,
			providers: {
				...cfg.models?.providers,
				xai: {
					...provider,
					models
				}
			}
		}
	};
}
function applyXaiProviderConfig(cfg) {
	return xaiPresetAppliers.applyProviderConfig(pruneRetiredXaiBuiltinModels(cfg), "openai-responses");
}
function applyXaiConfig(cfg) {
	return xaiPresetAppliers.applyConfig(pruneRetiredXaiBuiltinModels(cfg), "openai-responses");
}
//#endregion
export { applyXaiConfig as n, applyXaiProviderConfig as r, XAI_DEFAULT_MODEL_REF as t };
