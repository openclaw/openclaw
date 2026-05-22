import { _ as resolveSessionAgentId } from "./agent-scope-C51VTAKH.js";
import { r as resolveAgentConfig } from "./agent-scope-config-C5zL9i5G.js";
import { n as resolveSandboxRuntimeStatus } from "./runtime-status-DEs8rOEs.js";
import { u as loadExecApprovals } from "./exec-approvals-MvGngt6c.js";
import { l as isRequestedExecTargetAllowed, p as resolveExecTarget } from "./bash-tools.exec-runtime-D4G5VHSa.js";
//#region src/agents/exec-defaults.ts
function resolveExecConfigState(params) {
	const cfg = params.cfg ?? {};
	const resolvedAgentId = params.agentId ?? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: cfg
	});
	const globalExec = cfg.tools?.exec;
	const agentExec = resolvedAgentId ? resolveAgentConfig(cfg, resolvedAgentId)?.tools?.exec : void 0;
	return {
		cfg,
		host: params.sessionEntry?.execHost ?? agentExec?.host ?? globalExec?.host ?? "auto",
		agentExec,
		globalExec
	};
}
function resolveExecSandboxAvailability(params) {
	return params.sandboxAvailable ?? (params.sessionKey ? resolveSandboxRuntimeStatus({
		cfg: params.cfg,
		sessionKey: params.sessionKey
	}).sandboxed : false);
}
function canExecRequestNode(params) {
	const { cfg, host } = resolveExecConfigState(params);
	return isRequestedExecTargetAllowed({
		configuredTarget: host,
		requestedTarget: "node",
		sandboxAvailable: resolveExecSandboxAvailability({
			cfg,
			sessionKey: params.sessionKey,
			sandboxAvailable: params.sandboxAvailable
		})
	});
}
function resolveExecDefaults(params) {
	const { cfg, host, agentExec, globalExec } = resolveExecConfigState(params);
	const sandboxAvailable = resolveExecSandboxAvailability({
		cfg,
		sessionKey: params.sessionKey,
		sandboxAvailable: params.sandboxAvailable
	});
	const resolved = resolveExecTarget({
		configuredTarget: host,
		elevatedRequested: false,
		sandboxAvailable
	});
	const approvalDefaults = loadExecApprovals().defaults;
	const defaultSecurity = resolved.effectiveHost === "sandbox" ? "deny" : "full";
	return {
		host,
		effectiveHost: resolved.effectiveHost,
		security: params.sessionEntry?.execSecurity ?? agentExec?.security ?? globalExec?.security ?? approvalDefaults?.security ?? defaultSecurity,
		ask: params.sessionEntry?.execAsk ?? agentExec?.ask ?? globalExec?.ask ?? approvalDefaults?.ask ?? "off",
		node: params.sessionEntry?.execNode ?? agentExec?.node ?? globalExec?.node,
		canRequestNode: isRequestedExecTargetAllowed({
			configuredTarget: host,
			requestedTarget: "node",
			sandboxAvailable
		})
	};
}
//#endregion
export { resolveExecDefaults as n, canExecRequestNode as t };
