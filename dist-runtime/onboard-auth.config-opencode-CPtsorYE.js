import { n as init_subsystem, t as createSubsystemLogger } from "./subsystem-CsPxmH8p.js";
import { t as applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared-0Mir11tv.js";
//#region src/agents/opencode-zen-models.ts
init_subsystem();
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
