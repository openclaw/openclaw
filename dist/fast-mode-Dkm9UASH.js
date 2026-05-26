import { i as normalizeFastMode } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { n as modelKey } from "./model-ref-shared-BkjJfDrJ.js";
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
