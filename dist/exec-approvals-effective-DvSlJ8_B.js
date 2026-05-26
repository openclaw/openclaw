import "./session-key-Bte0mmcq.js";
import { E as resolveExecApprovalAllowedDecisions, d as maxAsk, k as resolveExecApprovalsFromFile, p as minSecurity, t as DEFAULT_EXEC_APPROVAL_ASK_FALLBACK } from "./exec-approvals-Bef7TPVc.js";
//#region src/infra/exec-approvals-effective.ts
const DEFAULT_REQUESTED_SECURITY = "full";
const DEFAULT_REQUESTED_ASK = "off";
const DEFAULT_HOST_PATH = "~/.openclaw/exec-approvals.json";
const REQUESTED_DEFAULT_LABEL = {
	security: DEFAULT_REQUESTED_SECURITY,
	ask: DEFAULT_REQUESTED_ASK
};
function resolveRequestedHost(params) {
	const scopeValue = params.scopeExecConfig?.host;
	if (scopeValue !== void 0) return {
		value: scopeValue,
		sourcePath: "scope"
	};
	const globalValue = params.globalExecConfig?.host;
	if (globalValue !== void 0) return {
		value: globalValue,
		sourcePath: "tools.exec"
	};
	return {
		value: "auto",
		sourcePath: "__default__"
	};
}
function formatRequestedSource(params) {
	return params.sourcePath === "__default__" ? `OpenClaw default (${params.defaultValue})` : `${params.sourcePath}.${params.field}`;
}
function resolveRequestedField(params) {
	const scopeValue = params.scopeExecConfig?.[params.field];
	if (scopeValue !== void 0) return {
		value: scopeValue,
		sourcePath: "scope"
	};
	const globalValue = params.globalExecConfig?.[params.field];
	if (globalValue !== void 0) return {
		value: globalValue,
		sourcePath: "tools.exec"
	};
	return {
		value: REQUESTED_DEFAULT_LABEL[params.field],
		sourcePath: "__default__"
	};
}
function formatHostFieldSource(params) {
	if (params.sourceSuffix) return `${params.hostPath} ${params.sourceSuffix}`;
	if (params.field === "askFallback") return `OpenClaw default (${DEFAULT_EXEC_APPROVAL_ASK_FALLBACK})`;
	return "inherits requested tool policy";
}
function resolveAskNote(params) {
	if (params.effectiveAsk === params.requestedAsk) return "requested ask applies";
	return "more aggressive ask wins";
}
function collectExecPolicyScopeSnapshots(params) {
	const snapshots = [resolveExecPolicyScopeSnapshot({
		approvals: params.approvals,
		scopeExecConfig: params.cfg.tools?.exec,
		configPath: "tools.exec",
		hostPath: params.hostPath,
		scopeLabel: "tools.exec"
	})];
	const globalExecConfig = params.cfg.tools?.exec;
	const configAgentIds = new Set((params.cfg.agents?.list ?? []).filter((agent) => agent.id !== "main" || agent.tools?.exec !== void 0).map((agent) => agent.id));
	const approvalAgentIds = Object.keys(params.approvals.agents ?? {}).filter((agentId) => agentId !== "*" && agentId !== "default" && agentId !== "main");
	const agentIds = Array.from(new Set([...configAgentIds, ...approvalAgentIds])).toSorted();
	for (const agentId of agentIds) {
		const agentConfig = params.cfg.agents?.list?.find((agent) => agent.id === agentId);
		snapshots.push(resolveExecPolicyScopeSnapshot({
			approvals: params.approvals,
			scopeExecConfig: agentConfig?.tools?.exec,
			globalExecConfig,
			configPath: `agents.list.${agentId}.tools.exec`,
			hostPath: params.hostPath,
			scopeLabel: `agent:${agentId}`,
			agentId
		}));
	}
	return snapshots;
}
function resolveExecPolicyScopeSnapshot(params) {
	const requestedSecurity = resolveRequestedField({
		field: "security",
		scopeExecConfig: params.scopeExecConfig,
		globalExecConfig: params.globalExecConfig
	});
	const requestedHost = resolveRequestedHost({
		scopeExecConfig: params.scopeExecConfig,
		globalExecConfig: params.globalExecConfig
	});
	const requestedAsk = resolveRequestedField({
		field: "ask",
		scopeExecConfig: params.scopeExecConfig,
		globalExecConfig: params.globalExecConfig
	});
	const resolved = resolveExecApprovalsFromFile({
		file: params.approvals,
		agentId: params.agentId,
		overrides: {
			security: requestedSecurity.value,
			ask: requestedAsk.value
		}
	});
	const hostPath = params.hostPath ?? DEFAULT_HOST_PATH;
	const effectiveSecurity = minSecurity(requestedSecurity.value, resolved.agent.security);
	const effectiveAsk = maxAsk(requestedAsk.value, resolved.agent.ask);
	const effectiveAskFallback = minSecurity(effectiveSecurity, resolved.agent.askFallback);
	return {
		scopeLabel: params.scopeLabel,
		configPath: params.configPath,
		...params.agentId ? { agentId: params.agentId } : {},
		host: {
			requested: requestedHost.value,
			requestedSource: requestedHost.sourcePath === "__default__" ? "OpenClaw default (auto)" : `${requestedHost.sourcePath === "scope" ? params.configPath : requestedHost.sourcePath}.host`
		},
		security: {
			requested: requestedSecurity.value,
			requestedSource: formatRequestedSource({
				sourcePath: requestedSecurity.sourcePath === "scope" ? params.configPath : requestedSecurity.sourcePath,
				field: "security",
				defaultValue: DEFAULT_REQUESTED_SECURITY
			}),
			host: resolved.agent.security,
			hostSource: formatHostFieldSource({
				hostPath,
				field: "security",
				sourceSuffix: resolved.agentSources.security
			}),
			effective: effectiveSecurity,
			note: effectiveSecurity === requestedSecurity.value ? "requested security applies" : "stricter host security wins"
		},
		ask: {
			requested: requestedAsk.value,
			requestedSource: formatRequestedSource({
				sourcePath: requestedAsk.sourcePath === "scope" ? params.configPath : requestedAsk.sourcePath,
				field: "ask",
				defaultValue: DEFAULT_REQUESTED_ASK
			}),
			host: resolved.agent.ask,
			hostSource: formatHostFieldSource({
				hostPath,
				field: "ask",
				sourceSuffix: resolved.agentSources.ask
			}),
			effective: effectiveAsk,
			note: resolveAskNote({
				requestedAsk: requestedAsk.value,
				hostAsk: resolved.agent.ask,
				effectiveAsk
			})
		},
		askFallback: {
			effective: effectiveAskFallback,
			source: formatHostFieldSource({
				hostPath,
				field: "askFallback",
				sourceSuffix: resolved.agentSources.askFallback
			})
		},
		allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: effectiveAsk })
	};
}
//#endregion
export { resolveExecPolicyScopeSnapshot as n, collectExecPolicyScopeSnapshots as t };
