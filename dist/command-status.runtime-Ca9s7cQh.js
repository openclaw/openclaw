import { t as listAgentEntries } from "./agent-scope-config-26EcJVc0.js";
import { p as resolveSessionAgentId } from "./agent-scope-C1Fl7gAf.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-VRXWv5rs.js";
import { c as loadSessionEntry } from "./session-utils-BcTdpiLf.js";
import { t as resolveDefaultModel } from "./directive-handling.defaults-DkcwBQIk.js";
import { n as createModelSelectionState } from "./model-selection-zb8joq0t.js";
import { t as buildStatusReply } from "./commands-status-FDM5jQOP.js";
import { t as resolveCurrentDirectiveLevels } from "./directive-handling.levels-D5zOborL.js";
//#region src/plugin-sdk/command-status.runtime.ts
async function resolveDirectStatusReplyForSession(params) {
	const requestedSessionKey = params.sessionKey.trim();
	if (!requestedSessionKey) return;
	const statusLoaded = loadSessionEntry(requestedSessionKey);
	const statusCfg = statusLoaded.cfg ?? params.cfg;
	const statusSessionKey = statusLoaded.canonicalKey;
	const statusEntry = statusLoaded.entry;
	const statusAgentId = resolveSessionAgentId({
		sessionKey: statusSessionKey,
		config: statusCfg
	});
	const agentCfg = statusCfg.agents?.defaults;
	const agentEntry = listAgentEntries(statusCfg).find((entry) => entry.id?.trim().toLowerCase() === statusAgentId);
	const statusModel = resolveDefaultModelForAgent({
		cfg: statusCfg,
		agentId: statusAgentId
	});
	const { defaultProvider, defaultModel } = resolveDefaultModel({
		cfg: statusCfg,
		agentId: statusAgentId
	});
	const selectedProvider = statusEntry?.providerOverride?.trim() || statusEntry?.modelProvider?.trim() || statusModel.provider;
	const selectedModel = statusEntry?.modelOverride?.trim() || statusEntry?.model?.trim() || statusModel.model;
	const modelState = await createModelSelectionState({
		cfg: statusCfg,
		agentId: statusAgentId,
		agentCfg,
		sessionEntry: statusEntry,
		sessionStore: statusLoaded.store,
		sessionKey: statusSessionKey,
		parentSessionKey: statusEntry?.parentSessionKey,
		storePath: statusLoaded.storePath,
		defaultProvider,
		defaultModel,
		provider: selectedProvider,
		model: selectedModel,
		hasModelDirective: false
	});
	const { currentThinkLevel, currentFastMode, currentVerboseLevel, currentReasoningLevel, currentElevatedLevel } = await resolveCurrentDirectiveLevels({
		sessionEntry: statusEntry,
		agentEntry,
		agentCfg,
		resolveDefaultThinkingLevel: () => modelState.resolveDefaultThinkingLevel()
	});
	let resolvedReasoningLevel = currentReasoningLevel;
	const hasAgentReasoningDefault = agentEntry?.reasoningDefault !== void 0 && agentEntry.reasoningDefault !== null || agentCfg?.reasoningDefault !== void 0 && agentCfg.reasoningDefault !== null;
	const sessionReasoningExplicitlySet = statusEntry?.reasoningLevel !== void 0 && statusEntry.reasoningLevel !== null;
	if (!(params.senderIsOwner || params.isAuthorizedSender) && (sessionReasoningExplicitlySet || hasAgentReasoningDefault)) resolvedReasoningLevel = "off";
	if (!(sessionReasoningExplicitlySet || hasAgentReasoningDefault) && resolvedReasoningLevel === "off" && currentThinkLevel === "off") resolvedReasoningLevel = await modelState.resolveDefaultReasoningLevel();
	return await buildStatusReply({
		cfg: statusCfg,
		command: {
			surface: params.channel,
			channel: params.channel,
			ownerList: [],
			senderIsOwner: params.senderIsOwner,
			isAuthorizedSender: params.isAuthorizedSender,
			senderId: params.senderId,
			rawBodyNormalized: "/status",
			commandBodyNormalized: "/status"
		},
		sessionEntry: statusEntry,
		sessionKey: statusSessionKey,
		parentSessionKey: statusEntry?.parentSessionKey,
		sessionScope: statusCfg.session?.scope,
		storePath: statusLoaded.storePath,
		provider: selectedProvider,
		model: selectedModel,
		contextTokens: statusEntry?.contextTokens ?? 0,
		resolvedThinkLevel: currentThinkLevel,
		resolvedFastMode: currentFastMode,
		resolvedVerboseLevel: currentVerboseLevel ?? "off",
		resolvedReasoningLevel,
		resolvedElevatedLevel: currentElevatedLevel,
		resolveDefaultThinkingLevel: () => modelState.resolveDefaultThinkingLevel(),
		isGroup: params.isGroup,
		defaultGroupActivation: params.defaultGroupActivation
	});
}
//#endregion
export { resolveDirectStatusReplyForSession };
