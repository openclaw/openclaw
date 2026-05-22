//#region src/plugins/provider-model-primary.ts
function applyPrimaryModel(cfg, model) {
	const defaults = cfg.agents?.defaults;
	const existingModel = defaults?.model;
	const existingModels = defaults?.models;
	const fallbacks = typeof existingModel === "object" && existingModel !== null && "fallbacks" in existingModel ? existingModel.fallbacks : void 0;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...defaults,
				model: {
					...fallbacks ? { fallbacks } : void 0,
					primary: model
				},
				models: {
					...existingModels,
					[model]: existingModels?.[model] ?? {}
				}
			}
		}
	};
}
//#endregion
export { applyPrimaryModel as t };
