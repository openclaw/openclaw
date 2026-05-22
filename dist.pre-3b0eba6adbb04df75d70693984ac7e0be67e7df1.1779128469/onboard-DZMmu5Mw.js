import { n as applyAgentDefaultModelPrimary } from "./provider-onboard-CcLeYLtB.js";
import { r as DEEPINFRA_DEFAULT_MODEL_REF } from "./provider-models-uO0-f4nt.js";
//#region extensions/deepinfra/onboard.ts
function applyDeepInfraProviderConfig(cfg, modelRef = DEEPINFRA_DEFAULT_MODEL_REF) {
	const models = { ...cfg.agents?.defaults?.models };
	models[modelRef] = {
		...models[modelRef],
		alias: models[modelRef]?.alias ?? "DeepInfra"
	};
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models
			}
		}
	};
}
function applyDeepInfraConfig(cfg, modelRef = DEEPINFRA_DEFAULT_MODEL_REF) {
	return applyAgentDefaultModelPrimary(applyDeepInfraProviderConfig(cfg, modelRef), modelRef);
}
//#endregion
export { applyDeepInfraProviderConfig as n, applyDeepInfraConfig as t };
