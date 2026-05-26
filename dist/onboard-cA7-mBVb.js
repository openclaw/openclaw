import { f as createDefaultModelsPresetAppliers } from "./provider-onboard-DhuPxzG7.js";
import { a as XAI_DEFAULT_MODEL_ID, c as buildXaiCatalogModels, t as XAI_BASE_URL } from "./model-definitions-DmV6zJgC.js";
//#region extensions/xai/onboard.ts
const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;
const xaiPresetAppliers = createDefaultModelsPresetAppliers({
	primaryModelRef: XAI_DEFAULT_MODEL_REF,
	resolveParams: (_cfg, api) => ({
		providerId: "xai",
		api,
		baseUrl: XAI_BASE_URL,
		defaultModels: buildXaiCatalogModels(),
		defaultModelId: XAI_DEFAULT_MODEL_ID,
		aliases: [{
			modelRef: XAI_DEFAULT_MODEL_REF,
			alias: "Grok"
		}]
	})
});
function applyXaiProviderConfig(cfg) {
	return xaiPresetAppliers.applyProviderConfig(cfg, "openai-responses");
}
function applyXaiConfig(cfg) {
	return xaiPresetAppliers.applyConfig(cfg, "openai-responses");
}
//#endregion
export { applyXaiConfig as n, applyXaiProviderConfig as r, XAI_DEFAULT_MODEL_REF as t };
