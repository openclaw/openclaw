import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir, r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import "./agent-runtime-Lc7H-PlR.js";
import { d as resolveHomePath } from "./helpers-B_eVYvP7.js";
import path from "node:path";
//#region extensions/migrate-hermes/targets.ts
function resolveTargets(ctx) {
	const cfg = ctx.config;
	const agentId = resolveDefaultAgentId(cfg);
	const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
	const configuredAgentDir = resolveAgentConfig(cfg, agentId)?.agentDir?.trim();
	const agentDir = ctx.runtime?.agent?.resolveAgentDir(cfg, agentId) ?? (configuredAgentDir ? resolveHomePath(configuredAgentDir) : void 0) ?? path.join(ctx.stateDir, "agents", agentId, "agent");
	return {
		workspaceDir,
		stateDir: ctx.stateDir,
		agentDir
	};
}
//#endregion
export { resolveTargets as t };
