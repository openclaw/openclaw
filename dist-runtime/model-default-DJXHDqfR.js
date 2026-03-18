//#region src/commands/model-default.ts
function resolvePrimaryModel(model) {
	if (typeof model === "string") return model;
	if (model && typeof model === "object" && typeof model.primary === "string") return model.primary;
}
function applyAgentDefaultPrimaryModel(params) {
	const current = resolvePrimaryModel(params.cfg.agents?.defaults?.model)?.trim();
	if ((current && params.legacyModels?.has(current) ? params.model : current) === params.model) return {
		next: params.cfg,
		changed: false
	};
	return {
		next: {
			...params.cfg,
			agents: {
				...params.cfg.agents,
				defaults: {
					...params.cfg.agents?.defaults,
					model: params.cfg.agents?.defaults?.model && typeof params.cfg.agents.defaults.model === "object" ? {
						...params.cfg.agents.defaults.model,
						primary: params.model
					} : { primary: params.model }
				}
			}
		},
		changed: true
	};
}
//#endregion
export { applyAgentDefaultPrimaryModel as t };
