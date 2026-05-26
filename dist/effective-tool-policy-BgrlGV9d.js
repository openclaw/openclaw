import { a as resolveToolProfilePolicy } from "./tool-policy-shared-CnnYZoj3.js";
import { r as applyOwnerOnlyToolPolicy, u as mergeAlsoAllowPolicy } from "./tool-policy-74_siKto.js";
import { i as getPluginToolMeta } from "./tools-DsGaQCaM.js";
import { i as resolveSubagentCapabilityStore, t as isSubagentEnvelopeSession } from "./subagent-capabilities-B4KLF7qT.js";
import { a as resolveSubagentToolPolicyForSession, n as resolveEffectiveToolPolicy, o as resolveTrustedGroupId, r as resolveGroupToolPolicy } from "./pi-tools.policy-BYHXXrrP.js";
import { t as resolveSenderToolPolicy } from "./sender-tool-policy-pkbFA5_F.js";
import { n as buildDefaultToolPolicyPipelineSteps, t as applyToolPolicyPipeline } from "./tool-policy-pipeline-Cx9u2Q6V.js";
//#region src/agents/pi-embedded-runner/effective-tool-policy.ts
function applyFinalEffectiveToolPolicy(params) {
	if (params.bundledTools.length === 0) return params.bundledTools;
	const trustedGroup = resolveTrustedGroupId(params);
	if (trustedGroup.dropped) params.warn("effective tool policy: dropping caller-provided groupId that does not match session-derived group context");
	const { agentId, globalPolicy, globalProviderPolicy, agentPolicy, agentProviderPolicy, profile, providerProfile, profileAlsoAllow, providerProfileAlsoAllow } = resolveEffectiveToolPolicy({
		config: params.config,
		sessionKey: params.sessionKey,
		agentId: params.agentId,
		modelProvider: params.modelProvider,
		modelId: params.modelId
	});
	const groupPolicy = resolveGroupToolPolicy({
		config: params.config,
		sessionKey: params.sessionKey,
		spawnedBy: params.spawnedBy,
		messageProvider: params.messageProvider,
		groupId: trustedGroup.groupId,
		groupChannel: trustedGroup.dropped ? null : params.groupChannel,
		groupSpace: trustedGroup.dropped ? null : params.groupSpace,
		accountId: params.agentAccountId,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	});
	const senderPolicy = resolveSenderToolPolicy({
		config: params.config,
		agentId,
		messageProvider: params.messageProvider,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	});
	const profilePolicy = resolveToolProfilePolicy(profile);
	const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
	const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, profileAlsoAllow);
	const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(providerProfilePolicy, providerProfileAlsoAllow);
	const subagentStore = resolveSubagentCapabilityStore(params.sessionKey, { cfg: params.config });
	const subagentPolicy = params.sessionKey && isSubagentEnvelopeSession(params.sessionKey, {
		cfg: params.config,
		store: subagentStore
	}) ? resolveSubagentToolPolicyForSession(params.config, params.sessionKey, { store: subagentStore }) : void 0;
	const ownerFiltered = applyOwnerOnlyToolPolicy(params.bundledTools, params.senderIsOwner === true, params.ownerOnlyToolAllowlist);
	const pipelineSteps = [
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
			senderPolicy,
			agentId
		}),
		{
			policy: params.sandboxToolPolicy,
			label: "sandbox tools.allow"
		},
		{
			policy: subagentPolicy,
			label: "subagent tools.allow"
		}
	].map((step) => Object.assign({}, step, { suppressUnavailableCoreToolWarning: true }));
	return applyToolPolicyPipeline({
		tools: ownerFiltered,
		toolMeta: (tool) => getPluginToolMeta(tool),
		warn: params.warn,
		steps: pipelineSteps
	});
}
//#endregion
export { applyFinalEffectiveToolPolicy as t };
