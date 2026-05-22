import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-fFkwW_47.js";
import "./agent-scope-CBctHYDw.js";
import { a as logWarn } from "./logger-se9wHZOU.js";
import { i as resolveSubagentCapabilityStore, t as isSubagentEnvelopeSession } from "./subagent-capabilities-DMa6cF_X.js";
import { a as resolveToolProfilePolicy } from "./tool-policy-shared-DYW5KkT2.js";
import { a as collectExplicitAllowlist, o as collectExplicitDenylist, u as mergeAlsoAllowPolicy } from "./tool-policy-DIworFrv.js";
import { t as createOpenClawTools } from "./openclaw-tools-CI2JwuoV.js";
import { i as getPluginToolMeta } from "./tools-CHNWu-2k.js";
import { a as resolveSubagentToolPolicyForSession, n as resolveEffectiveToolPolicy, r as resolveGroupToolPolicy } from "./pi-tools.policy-DLm8KpJh.js";
import { n as buildDefaultToolPolicyPipelineSteps, t as applyToolPolicyPipeline } from "./tool-policy-pipeline-DI2a2xc0.js";
import { t as DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "./dangerous-tools-wAL12PqI.js";
//#region src/gateway/tool-resolution.ts
function resolveGatewayScopedTools(params) {
	const { agentId, globalPolicy, globalProviderPolicy, agentPolicy, agentProviderPolicy, profile, providerProfile, profileAlsoAllow, providerProfileAlsoAllow } = resolveEffectiveToolPolicy({
		config: params.cfg,
		sessionKey: params.sessionKey
	});
	const profilePolicy = resolveToolProfilePolicy(profile);
	const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
	const gatewayRequestedTools = params.gatewayRequestedTools ?? [];
	const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, [...profileAlsoAllow ?? [], ...gatewayRequestedTools]);
	const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(providerProfilePolicy, [...providerProfileAlsoAllow ?? [], ...gatewayRequestedTools]);
	const groupPolicy = resolveGroupToolPolicy({
		config: params.cfg,
		sessionKey: params.sessionKey,
		messageProvider: params.messageProvider,
		accountId: params.accountId ?? null
	});
	const subagentStore = resolveSubagentCapabilityStore(params.sessionKey, { cfg: params.cfg });
	const subagentPolicy = isSubagentEnvelopeSession(params.sessionKey, {
		cfg: params.cfg,
		store: subagentStore
	}) ? resolveSubagentToolPolicyForSession(params.cfg, params.sessionKey, { store: subagentStore }) : void 0;
	const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId ?? resolveDefaultAgentId(params.cfg));
	const policyFiltered = applyToolPolicyPipeline({
		tools: createOpenClawTools({
			agentSessionKey: params.sessionKey,
			agentChannel: params.messageProvider ?? void 0,
			agentAccountId: params.accountId,
			agentTo: params.agentTo,
			agentThreadId: params.agentThreadId,
			allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
			allowMediaInvokeCommands: params.allowMediaInvokeCommands,
			disablePluginTools: params.disablePluginTools,
			wrapBeforeToolCallHook: false,
			senderIsOwner: params.senderIsOwner,
			config: params.cfg,
			liveSessionToolConfig: true,
			workspaceDir,
			pluginToolAllowlist: collectExplicitAllowlist([
				profilePolicy,
				providerProfilePolicy,
				globalPolicy,
				globalProviderPolicy,
				agentPolicy,
				agentProviderPolicy,
				groupPolicy,
				subagentPolicy,
				gatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : void 0
			]),
			pluginToolDenylist: collectExplicitDenylist([
				profilePolicy,
				providerProfilePolicy,
				globalPolicy,
				globalProviderPolicy,
				agentPolicy,
				agentProviderPolicy,
				groupPolicy,
				subagentPolicy
			])
		}),
		toolMeta: (tool) => getPluginToolMeta(tool),
		warn: logWarn,
		steps: [...buildDefaultToolPolicyPipelineSteps({
			profilePolicy: profilePolicyWithAlsoAllow,
			profile,
			profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
			providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
			providerProfile,
			providerProfileUnavailableCoreWarningAllowlist: providerProfilePolicy?.allow,
			globalPolicy,
			globalProviderPolicy,
			agentPolicy,
			agentProviderPolicy,
			groupPolicy,
			agentId
		}), {
			policy: subagentPolicy,
			label: "subagent tools.allow"
		}]
	});
	const surface = params.surface ?? "http";
	const gatewayToolsCfg = params.cfg.gateway?.tools;
	const defaultGatewayDeny = surface === "http" ? DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter((name) => !gatewayToolsCfg?.allow?.includes(name)) : [];
	const gatewayDenySet = new Set([
		...defaultGatewayDeny,
		...Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : [],
		...params.excludeToolNames ? Array.from(params.excludeToolNames) : []
	]);
	return {
		agentId,
		tools: policyFiltered.filter((tool) => !gatewayDenySet.has(tool.name))
	};
}
//#endregion
export { resolveGatewayScopedTools as t };
