import { d as createDefaultModelPresetAppliers } from "./provider-onboard-Co6z08g0.js";
import { n as KIMI_CODING_DEFAULT_MODEL_ID, r as buildKimiCodingProvider, t as KIMI_CODING_BASE_URL } from "./provider-catalog-Qi1YeDV5.js";
//#region extensions/kimi-coding/onboard.ts
const KIMI_MODEL_REF = `kimi/${KIMI_CODING_DEFAULT_MODEL_ID}`;
const KIMI_CODING_MODEL_REF = KIMI_MODEL_REF;
function resolveKimiCodingDefaultModel() {
	return buildKimiCodingProvider().models[0];
}
const kimiCodingPresetAppliers = createDefaultModelPresetAppliers({
	primaryModelRef: KIMI_MODEL_REF,
	resolveParams: (_cfg) => {
		const defaultModel = resolveKimiCodingDefaultModel();
		if (!defaultModel) return null;
		return {
			providerId: "kimi",
			api: "anthropic-messages",
			baseUrl: KIMI_CODING_BASE_URL,
			defaultModel,
			defaultModelId: KIMI_CODING_DEFAULT_MODEL_ID,
			aliases: [{
				modelRef: KIMI_MODEL_REF,
				alias: "Kimi"
			}]
		};
	}
});
function applyKimiCodeProviderConfig(cfg) {
	return kimiCodingPresetAppliers.applyProviderConfig(cfg);
}
function applyKimiCodeConfig(cfg) {
	return kimiCodingPresetAppliers.applyConfig(cfg);
}
//#endregion
export { applyKimiCodeProviderConfig as i, KIMI_MODEL_REF as n, applyKimiCodeConfig as r, KIMI_CODING_MODEL_REF as t };
