import { n as applyAgentDefaultModelPrimary } from "./provider-onboard-MLXAQX8H.js";
//#region extensions/openrouter/onboard.ts
const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";
function applyOpenrouterProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[OPENROUTER_DEFAULT_MODEL_REF] = {
		...models[OPENROUTER_DEFAULT_MODEL_REF],
		alias: models["openrouter/auto"]?.alias ?? "OpenRouter"
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
function applyOpenrouterConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyOpenrouterProviderConfig(cfg), OPENROUTER_DEFAULT_MODEL_REF);
}
//#endregion
export { applyOpenrouterConfig as n, applyOpenrouterProviderConfig as r, OPENROUTER_DEFAULT_MODEL_REF as t };
