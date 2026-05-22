import { v as resolveAgentConfig } from "./agent-scope-CcybJBoN.js";
import { n as pickSandboxToolPolicy } from "./sandbox-tool-policy-IJ3eIW-L.js";
import { a as resolveToolProfilePolicy } from "./tool-policy-shared-CrK_yjQ1.js";
import { u as mergeAlsoAllowPolicy } from "./tool-policy-3ure4mbZ.js";
import { t as isToolAllowedByPolicies } from "./tool-policy-match-CFcwSzdf.js";
//#region src/agents/tool-fs-policy.ts
function createToolFsPolicy(params) {
	return { workspaceOnly: params.workspaceOnly === true };
}
function resolveToolFsConfig(params) {
	const cfg = params.cfg;
	const globalFs = cfg?.tools?.fs;
	return { workspaceOnly: (cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : void 0)?.workspaceOnly ?? globalFs?.workspaceOnly };
}
function resolveEffectiveToolFsWorkspaceOnly(params) {
	return resolveToolFsConfig(params).workspaceOnly === true;
}
function resolveEffectiveToolFsRootExpansionAllowed(params) {
	const cfg = params.cfg;
	if (!cfg) return true;
	const agentTools = params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools : void 0;
	const globalTools = cfg.tools;
	const profile = agentTools?.profile ?? globalTools?.profile;
	const profileAlsoAllow = new Set(agentTools?.alsoAllow ?? globalTools?.alsoAllow ?? []);
	if (resolveToolFsConfig(params).workspaceOnly === true) return false;
	return isToolAllowedByPolicies("read", [
		mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), profileAlsoAllow.size > 0 ? Array.from(profileAlsoAllow) : void 0),
		pickSandboxToolPolicy(globalTools),
		pickSandboxToolPolicy(agentTools)
	]);
}
//#endregion
export { resolveToolFsConfig as i, resolveEffectiveToolFsRootExpansionAllowed as n, resolveEffectiveToolFsWorkspaceOnly as r, createToolFsPolicy as t };
