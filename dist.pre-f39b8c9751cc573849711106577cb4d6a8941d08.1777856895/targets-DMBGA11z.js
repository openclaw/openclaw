import { S as resolveDefaultAgentId, v as resolveAgentConfig, x as resolveAgentWorkspaceDir } from "./agent-scope-CzfWAE9r.js";
import "./agent-runtime-qMp10Usv.js";
import { d as resolveHomePath } from "./helpers-C_Zp9Uy-.js";
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
