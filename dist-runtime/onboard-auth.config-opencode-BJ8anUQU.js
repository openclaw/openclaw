import { t as createSubsystemLogger } from "./subsystem-CsP80x3t.js";
import { t as applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared-DFRZVnAu.js";
createSubsystemLogger("opencode-zen-models");
const OPENCODE_ZEN_DEFAULT_MODEL_REF = `opencode/claude-opus-4-6`;
//#endregion
//#region src/commands/onboard-auth.config-opencode.ts
function applyOpencodeZenProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[OPENCODE_ZEN_DEFAULT_MODEL_REF] = {
		...models[OPENCODE_ZEN_DEFAULT_MODEL_REF],
		alias: models[OPENCODE_ZEN_DEFAULT_MODEL_REF]?.alias ?? "Opus"
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
function applyOpencodeZenConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyOpencodeZenProviderConfig(cfg), OPENCODE_ZEN_DEFAULT_MODEL_REF);
}
//#endregion
export { applyOpencodeZenConfig as t };
