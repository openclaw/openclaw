import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { a as logWarn } from "./logger-0o2znY2U.js";
import { t as createOpenClawTools } from "./openclaw-tools-QeySpphx.js";
import { a as collectExplicitDenylist, c as hasRestrictiveAllowPolicy, h as resolveToolProfilePolicy, i as collectExplicitAllowlist, l as mergeAlsoAllowPolicy, u as replaceWithEffectiveToolAllowlist } from "./tool-policy-COX5DaEj.js";
import { o as resolveSubagentCapabilityStore, t as isSubagentEnvelopeSession } from "./subagent-capabilities-mB73wM9t.js";
import { i as resolveInheritedToolPolicyForSession, n as resolveEffectiveToolPolicy, o as resolveSubagentToolPolicyForSession, r as resolveGroupToolPolicy } from "./pi-tools.policy-DWPg8MXT.js";
import { i as getPluginToolMeta } from "./tools-KpflAzxD.js";
import { n as buildDefaultToolPolicyPipelineSteps, t as applyToolPolicyPipeline } from "./tool-policy-pipeline-BpnQkjNH.js";
import { t as DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "./dangerous-tools-BaAMwWoo.js";
//#region src/gateway/tool-resolution.ts
function resolveGatewayScopedTools(params) {
	const { agentId, globalPolicy, globalProviderPolicy, agentPolicy, agentProviderPolicy, profile, providerProfile, profileAlsoAllow, providerProfileAlsoAllow } = resolveEffectiveToolPolicy({
		config: params.cfg,
		sessionKey: params.sessionKey
	});
	const profilePolicy = resolveToolProfilePolicy(profile);
	const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
	const gatewayRequestedTools = params.gatewayRequestedTools ?? [];
	const sourceReplyDeliveryMode = params.inboundEventKind === "room_event" ? "message_tool_only" : void 0;
	const runtimeAlsoAllow = sourceReplyDeliveryMode === "message_tool_only" ? ["message"] : [];
	const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, [
		...profileAlsoAllow ?? [],
		...gatewayRequestedTools,
		...runtimeAlsoAllow
	]);
	const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(providerProfilePolicy, [
		...providerProfileAlsoAllow ?? [],
		...gatewayRequestedTools,
		...runtimeAlsoAllow
	]);
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
	const inheritedToolPolicy = resolveInheritedToolPolicyForSession(params.cfg, params.sessionKey, { store: subagentStore });
	const excludedToolNames = params.excludeToolNames ? Array.from(params.excludeToolNames) : [];
	const surface = params.surface ?? "http";
	const gatewayToolsCfg = params.cfg.gateway?.tools;
	const defaultGatewayDeny = surface === "http" ? DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter((name) => !gatewayToolsCfg?.allow?.includes(name)) : [];
	const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId ?? resolveDefaultAgentId(params.cfg));
	const explicitDenylist = collectExplicitDenylist([
		profilePolicy,
		providerProfilePolicy,
		globalPolicy,
		globalProviderPolicy,
		agentPolicy,
		agentProviderPolicy,
		groupPolicy,
		subagentPolicy,
		inheritedToolPolicy,
		defaultGatewayDeny.length > 0 ? { deny: defaultGatewayDeny } : void 0,
		Array.isArray(gatewayToolsCfg?.deny) ? { deny: gatewayToolsCfg.deny } : void 0,
		excludedToolNames.length > 0 ? { deny: excludedToolNames } : void 0
	]);
	const inheritedToolDenylist = [...explicitDenylist];
	const inheritedToolAllowlist = [];
	const shouldInheritEffectiveToolAllowlist = [
		profilePolicy,
		providerProfilePolicy,
		globalPolicy,
		globalProviderPolicy,
		agentPolicy,
		agentProviderPolicy,
		groupPolicy,
		subagentPolicy,
		inheritedToolPolicy,
		gatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : void 0
	].some(hasRestrictiveAllowPolicy);
	const policyFiltered = applyToolPolicyPipeline({
		tools: createOpenClawTools({
			agentSessionKey: params.sessionKey,
			agentChannel: params.messageProvider ?? void 0,
			agentAccountId: params.accountId,
			inboundEventKind: params.inboundEventKind,
			sourceReplyDeliveryMode,
			agentTo: params.agentTo,
			agentThreadId: params.agentThreadId,
			senderIsOwner: params.senderIsOwner,
			allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
			allowMediaInvokeCommands: params.allowMediaInvokeCommands,
			disablePluginTools: params.disablePluginTools,
			wrapBeforeToolCallHook: false,
			config: params.cfg,
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
				inheritedToolPolicy,
				gatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : void 0
			]),
			pluginToolDenylist: explicitDenylist,
			inheritedToolAllowlist,
			inheritedToolDenylist
		}),
		toolMeta: (tool) => getPluginToolMeta(tool),
		warn: logWarn,
		steps: [
			...buildDefaultToolPolicyPipelineSteps({
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
			}),
			{
				policy: subagentPolicy,
				label: "subagent tools.allow"
			},
			{
				policy: inheritedToolPolicy,
				label: "inherited tools"
			}
		]
	});
	const gatewayDenySet = new Set([
		...defaultGatewayDeny,
		...Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : [],
		...excludedToolNames
	]);
	const tools = policyFiltered.filter((tool) => !gatewayDenySet.has(tool.name));
	if (shouldInheritEffectiveToolAllowlist) replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, tools);
	return {
		agentId,
		tools
	};
}
//#endregion
export { resolveGatewayScopedTools as t };
