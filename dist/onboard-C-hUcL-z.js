import { h as withAgentModelAliases, n as applyAgentDefaultModelPrimary } from "./provider-onboard-MLXAQX8H.js";
//#region extensions/opencode/onboard.ts
const OPENCODE_ZEN_DEFAULT_MODEL_REF = "opencode/claude-opus-4-6";
function applyOpencodeZenProviderConfig(cfg) {
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models: withAgentModelAliases(cfg.agents?.defaults?.models, [{
					modelRef: OPENCODE_ZEN_DEFAULT_MODEL_REF,
					alias: "Opus"
				}])
			}
		}
	};
}
function applyOpencodeZenConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyOpencodeZenProviderConfig(cfg), OPENCODE_ZEN_DEFAULT_MODEL_REF);
}
//#endregion
export { applyOpencodeZenConfig as n, applyOpencodeZenProviderConfig as r, OPENCODE_ZEN_DEFAULT_MODEL_REF as t };
