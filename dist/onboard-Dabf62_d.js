import { f as createDefaultModelsPresetAppliers } from "./provider-onboard-MLXAQX8H.js";
import { n as buildNvidiaProvider, t as NVIDIA_DEFAULT_MODEL_ID } from "./provider-catalog-D5vErC62.js";
//#region extensions/nvidia/onboard.ts
const NVIDIA_DEFAULT_MODEL_REF = NVIDIA_DEFAULT_MODEL_ID;
const nvidiaPresetAppliers = createDefaultModelsPresetAppliers({
	primaryModelRef: NVIDIA_DEFAULT_MODEL_REF,
	resolveParams: (_cfg) => {
		const defaultProvider = buildNvidiaProvider();
		return {
			providerId: "nvidia",
			api: defaultProvider.api ?? "openai-completions",
			baseUrl: defaultProvider.baseUrl,
			defaultModels: defaultProvider.models ?? [],
			defaultModelId: NVIDIA_DEFAULT_MODEL_ID,
			aliases: [{
				modelRef: NVIDIA_DEFAULT_MODEL_REF,
				alias: "NVIDIA"
			}]
		};
	}
});
function applyNvidiaProviderConfig(cfg) {
	return nvidiaPresetAppliers.applyProviderConfig(cfg);
}
function applyNvidiaConfig(cfg) {
	return nvidiaPresetAppliers.applyConfig(cfg);
}
//#endregion
export { applyNvidiaConfig as n, applyNvidiaProviderConfig as r, NVIDIA_DEFAULT_MODEL_REF as t };
