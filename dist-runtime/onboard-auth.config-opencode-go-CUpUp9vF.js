import { t as applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared-0Mir11tv.js";
//#region src/commands/opencode-go-model-default.ts
const OPENCODE_GO_DEFAULT_MODEL_REF = "opencode-go/kimi-k2.5";
//#endregion
//#region src/commands/onboard-auth.config-opencode-go.ts
const OPENCODE_GO_ALIAS_DEFAULTS = {
	"opencode-go/kimi-k2.5": "Kimi",
	"opencode-go/glm-5": "GLM",
	"opencode-go/minimax-m2.5": "MiniMax"
};
function applyOpencodeGoProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	for (const [modelRef, alias] of Object.entries(OPENCODE_GO_ALIAS_DEFAULTS)) models[modelRef] = {
		...models[modelRef],
		alias: models[modelRef]?.alias ?? alias
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
function applyOpencodeGoConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyOpencodeGoProviderConfig(cfg), OPENCODE_GO_DEFAULT_MODEL_REF);
}
//#endregion
export { OPENCODE_GO_DEFAULT_MODEL_REF as n, applyOpencodeGoConfig as t };
