import { d as createDefaultModelPresetAppliers } from "./provider-onboard-MLXAQX8H.js";
import { a as buildMoonshotProvider, n as MOONSHOT_CN_BASE_URL, r as MOONSHOT_DEFAULT_MODEL_ID, t as MOONSHOT_BASE_URL } from "./provider-catalog-0bGkrp95.js";
//#region extensions/moonshot/onboard.ts
const MOONSHOT_DEFAULT_MODEL_REF = `moonshot/${MOONSHOT_DEFAULT_MODEL_ID}`;
const moonshotPresetAppliers = createDefaultModelPresetAppliers({
	primaryModelRef: MOONSHOT_DEFAULT_MODEL_REF,
	resolveParams: (_cfg, baseUrl) => {
		const defaultModel = buildMoonshotProvider().models[0];
		if (!defaultModel) return null;
		return {
			providerId: "moonshot",
			api: "openai-completions",
			baseUrl,
			defaultModel,
			defaultModelId: MOONSHOT_DEFAULT_MODEL_ID,
			aliases: [{
				modelRef: MOONSHOT_DEFAULT_MODEL_REF,
				alias: "Kimi"
			}]
		};
	}
});
function applyMoonshotConfig(cfg) {
	return moonshotPresetAppliers.applyConfig(cfg, MOONSHOT_BASE_URL);
}
function applyMoonshotConfigCn(cfg) {
	return moonshotPresetAppliers.applyConfig(cfg, MOONSHOT_CN_BASE_URL);
}
//#endregion
export { applyMoonshotConfig as n, applyMoonshotConfigCn as r, MOONSHOT_DEFAULT_MODEL_REF as t };
