//#region extensions/fal/onboard.ts
const FAL_DEFAULT_IMAGE_MODEL_REF = "fal/fal-ai/flux/dev";
function applyFalConfig(cfg) {
	if (cfg.agents?.defaults?.imageGenerationModel) return cfg;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				imageGenerationModel: { primary: FAL_DEFAULT_IMAGE_MODEL_REF }
			}
		}
	};
}
//#endregion
export { applyFalConfig as n, FAL_DEFAULT_IMAGE_MODEL_REF as t };
