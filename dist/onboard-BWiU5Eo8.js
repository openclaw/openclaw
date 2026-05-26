//#region extensions/vydra/onboard.ts
const VYDRA_DEFAULT_IMAGE_MODEL_REF = "vydra/grok-imagine";
function applyVydraConfig(cfg) {
	if (cfg.agents?.defaults?.imageGenerationModel) return cfg;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				imageGenerationModel: { primary: VYDRA_DEFAULT_IMAGE_MODEL_REF }
			}
		}
	};
}
//#endregion
export { applyVydraConfig as n, VYDRA_DEFAULT_IMAGE_MODEL_REF as t };
