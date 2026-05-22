import { i as normalizeFastMode } from "./string-coerce-LndEvhRk.js";
import "./agent-scope-B7Gl_3a6.js";
import { r as resolveAgentConfig } from "./agent-scope-config-BdqZvTnb.js";
import { n as modelKey } from "./model-ref-shared-BFiFeBhs.js";
//#region src/agents/fast-mode.ts
function resolveConfiguredFastModeRaw(params) {
	const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey(params.provider, params.model)];
	return modelConfig?.params?.fastMode ?? modelConfig?.params?.fast_mode;
}
function resolveFastModeState(params) {
	const sessionOverride = normalizeFastMode(params.sessionEntry?.fastMode);
	if (sessionOverride !== void 0) return {
		enabled: sessionOverride,
		source: "session"
	};
	const agentDefault = params.agentId && params.cfg ? resolveAgentConfig(params.cfg, params.agentId)?.fastModeDefault : void 0;
	if (typeof agentDefault === "boolean") return {
		enabled: agentDefault,
		source: "agent"
	};
	const configured = normalizeFastMode(resolveConfiguredFastModeRaw(params));
	if (configured !== void 0) return {
		enabled: configured,
		source: "config"
	};
	return {
		enabled: false,
		source: "default"
	};
}
//#endregion
export { resolveFastModeState as t };
