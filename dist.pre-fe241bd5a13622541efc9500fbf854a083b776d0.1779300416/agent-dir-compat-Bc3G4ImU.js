import { p as resolveUserPath } from "./utils-DX02THHb.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-C5zL9i5G.js";
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
