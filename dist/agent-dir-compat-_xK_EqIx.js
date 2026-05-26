import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
//#region src/plugin-sdk/agent-dir-compat.ts
/**
* @deprecated Prefer resolveAgentDir(cfg, agentId) or resolveDefaultAgentDir(cfg).
* Kept for third-party plugin SDK compatibility.
*/
function resolveOpenClawAgentDir(env = process.env) {
	const override = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
	return override ? resolveUserPath(override, env) : resolveDefaultAgentDir({}, env);
}
//#endregion
export { resolveOpenClawAgentDir as t };
