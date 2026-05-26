import { n as normalizeAgentModelRefForConfig, t as normalizeAgentModelMapForConfig } from "./model-input-ChW9XXsQ.js";
//#region src/plugins/provider-model-primary.ts
function applyPrimaryModel(cfg, model) {
	const normalizedModel = normalizeAgentModelRefForConfig(model);
	const defaults = cfg.agents?.defaults;
	const existingModel = defaults?.model;
	const existingModels = normalizeAgentModelMapForConfig(defaults?.models ?? {});
	const fallbacks = typeof existingModel === "object" && existingModel !== null && "fallbacks" in existingModel ? existingModel.fallbacks?.map((fallback) => normalizeAgentModelRefForConfig(fallback)) : void 0;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...defaults,
				model: {
					...fallbacks ? { fallbacks } : void 0,
					primary: normalizedModel
				},
				models: {
					...existingModels,
					[normalizedModel]: existingModels?.[normalizedModel] ?? {}
				}
			}
		}
	};
}
//#endregion
export { applyPrimaryModel as t };
