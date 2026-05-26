import { n as pickSandboxToolPolicy } from "./sandbox-tool-policy-7ufxS0Kx.js";
import { a as resolveToolProfilePolicy } from "./tool-policy-shared-CnnYZoj3.js";
import "./tool-policy-74_siKto.js";
import { r as resolveSandboxToolPolicyForAgent } from "./tool-policy-Defp5ENc.js";
import { i as resolveSandboxConfigForAgent } from "./config-BNHBQmxW.js";
import { t as isToolAllowedByPolicies } from "./tool-policy-match-CcVFOxJ8.js";
//#region src/security/exec-filesystem-policy.ts
const MUTATING_FS_TOOLS = [
	"write",
	"edit",
	"apply_patch"
];
const RUNTIME_TOOLS = ["exec", "process"];
function resolveToolPolicies(params) {
	const policies = [];
	const profilePolicy = resolveToolProfilePolicy(params.agentTools?.profile ?? params.cfg.tools?.profile);
	if (profilePolicy) policies.push(profilePolicy);
	const globalPolicy = pickSandboxToolPolicy(params.cfg.tools ?? void 0);
	if (globalPolicy) policies.push(globalPolicy);
	const agentPolicy = pickSandboxToolPolicy(params.agentTools);
	if (agentPolicy) policies.push(agentPolicy);
	if (params.sandboxMode === "all") policies.push(resolveSandboxToolPolicyForAgent(params.cfg, params.agentId));
	return policies;
}
function resolveExecHost(params) {
	return params.agentExec?.host ?? params.globalExec?.host ?? "auto";
}
function isExecFilesystemConstrained(params) {
	if (params.sandboxMode !== "all") return false;
	if (params.execHost === "gateway" || params.execHost === "node") return false;
	return params.sandboxWorkspaceAccess !== "rw";
}
function collectExecFilesystemPolicyDriftHits(cfg) {
	const hits = [];
	const globalExec = cfg.tools?.exec;
	const contexts = [{ scopeLabel: "tools" }];
	for (const agent of cfg.agents?.list ?? []) {
		if (!agent || typeof agent !== "object" || typeof agent.id !== "string") continue;
		contexts.push({
			scopeLabel: `agents.list.${agent.id}.tools`,
			agentId: agent.id,
			tools: agent.tools
		});
	}
	for (const context of contexts) {
		const sandbox = resolveSandboxConfigForAgent(cfg, context.agentId);
		const execHost = resolveExecHost({
			globalExec,
			agentExec: context.tools?.exec
		});
		if (isExecFilesystemConstrained({
			sandboxMode: sandbox.mode,
			sandboxWorkspaceAccess: sandbox.workspaceAccess,
			execHost
		})) continue;
		const policies = resolveToolPolicies({
			cfg,
			agentTools: context.tools,
			sandboxMode: sandbox.mode,
			agentId: context.agentId
		});
		const runtimeTools = RUNTIME_TOOLS.filter((tool) => isToolAllowedByPolicies(tool, policies));
		if (!runtimeTools.includes("exec")) continue;
		const disabledFilesystemTools = MUTATING_FS_TOOLS.filter((tool) => !isToolAllowedByPolicies(tool, policies));
		if (disabledFilesystemTools.length !== MUTATING_FS_TOOLS.length) continue;
		hits.push({
			scopeLabel: context.scopeLabel,
			runtimeTools,
			disabledFilesystemTools,
			sandboxMode: sandbox.mode,
			sandboxWorkspaceAccess: sandbox.workspaceAccess,
			execHost
		});
	}
	return hits;
}
//#endregion
export { collectExecFilesystemPolicyDriftHits as t };
