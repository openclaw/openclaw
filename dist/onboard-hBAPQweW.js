import { d as createDefaultModelPresetAppliers } from "./provider-onboard-DhuPxzG7.js";
import { a as MISTRAL_DEFAULT_MODEL_ID, s as buildMistralModelDefinition, t as MISTRAL_BASE_URL } from "./model-definitions-DAur9YW9.js";
//#region extensions/mistral/onboard.ts
const MISTRAL_DEFAULT_MODEL_REF = `mistral/${MISTRAL_DEFAULT_MODEL_ID}`;
const mistralPresetAppliers = createDefaultModelPresetAppliers({
	primaryModelRef: MISTRAL_DEFAULT_MODEL_REF,
	resolveParams: (_cfg) => ({
		providerId: "mistral",
		api: "openai-completions",
		baseUrl: MISTRAL_BASE_URL,
		defaultModel: buildMistralModelDefinition(),
		defaultModelId: MISTRAL_DEFAULT_MODEL_ID,
		aliases: [{
			modelRef: MISTRAL_DEFAULT_MODEL_REF,
			alias: "Mistral"
		}]
	})
});
function applyMistralProviderConfig(cfg) {
	return mistralPresetAppliers.applyProviderConfig(cfg);
}
function applyMistralConfig(cfg) {
	return mistralPresetAppliers.applyConfig(cfg);
}
//#endregion
export { applyMistralConfig as n, applyMistralProviderConfig as r, MISTRAL_DEFAULT_MODEL_REF as t };
