import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { l as parseRawSessionConversationRef, u as parseThreadSessionSuffix } from "./session-key-utils-Ce_xWkNq.js";
import { u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import { n as resolveSessionConversationRef, t as resolveSessionConversation } from "./session-conversation-XHNnUnBT.js";
import { t as normalizeChatType } from "./chat-type-D_QPUzR1.js";
import { a as resolveChannelEntryMatchWithFallback, n as buildChannelKeyCandidates, r as normalizeChannelSlug } from "./channel-config-BI04LRnO.js";
//#region src/channels/model-overrides.ts
function resolveProviderEntry(modelByChannel, channel) {
	const normalized = normalizeMessageChannel(channel) ?? normalizeOptionalLowercaseString(channel) ?? "";
	return modelByChannel?.[normalized] ?? modelByChannel?.[Object.keys(modelByChannel ?? {}).find((key) => {
		return (normalizeMessageChannel(key) ?? normalizeOptionalLowercaseString(key) ?? "") === normalized;
	}) ?? ""];
}
function buildChannelCandidates(params) {
	const normalizedChannel = normalizeMessageChannel(params.channel ?? "") ?? normalizeOptionalLowercaseString(params.channel);
	const groupId = normalizeOptionalString(params.groupId);
	const rawParentConversation = parseRawSessionConversationRef(params.parentSessionKey);
	const parentOverrideFallbacks = (normalizedChannel ? getChannelPlugin(normalizedChannel) : void 0)?.conversationBindings?.buildModelOverrideParentCandidates?.({ parentConversationId: rawParentConversation?.rawId }) ?? [];
	const sessionConversation = resolveSessionConversationRef(params.parentSessionKey, { bundledFallback: parentOverrideFallbacks.length === 0 });
	const groupConversationKind = normalizeChatType(params.groupChatType ?? void 0) === "channel" ? "channel" : sessionConversation?.kind === "channel" ? "channel" : "group";
	const groupConversation = resolveSessionConversation({
		channel: normalizedChannel ?? "",
		kind: groupConversationKind,
		rawId: groupId ?? ""
	});
	const groupChannel = normalizeOptionalString(params.groupChannel);
	const groupSubject = normalizeOptionalString(params.groupSubject);
	const channelBare = groupChannel ? groupChannel.replace(/^#/, "") : void 0;
	const subjectBare = groupSubject ? groupSubject.replace(/^#/, "") : void 0;
	const channelSlug = channelBare ? normalizeChannelSlug(channelBare) : void 0;
	const subjectSlug = subjectBare ? normalizeChannelSlug(subjectBare) : void 0;
	return {
		keys: buildChannelKeyCandidates(groupId, sessionConversation?.rawId, ...groupConversation?.parentConversationCandidates ?? [], ...sessionConversation?.parentConversationCandidates ?? [], ...parentOverrideFallbacks),
		parentKeys: buildChannelKeyCandidates(groupChannel, channelBare, channelSlug, groupSubject, subjectBare, subjectSlug)
	};
}
function buildGenericParentOverrideCandidates(sessionKey) {
	const raw = parseRawSessionConversationRef(sessionKey);
	if (!raw) return [];
	const { baseSessionKey, threadId } = parseThreadSessionSuffix(raw.rawId);
	return buildChannelKeyCandidates(threadId ? baseSessionKey : raw.rawId);
}
function resolveDirectChannelModelMatch(params) {
	const directKeys = buildChannelKeyCandidates(params.groupId, ...buildGenericParentOverrideCandidates(params.parentSessionKey));
	if (directKeys.length === 0) return null;
	const match = resolveChannelEntryMatchWithFallback({
		entries: params.providerEntries,
		keys: directKeys,
		parentKeys: [],
		wildcardKey: "*",
		normalizeKey: (value) => normalizeOptionalLowercaseString(value) ?? ""
	});
	const raw = match.entry ?? match.wildcardEntry;
	if (typeof raw !== "string") return null;
	const model = normalizeOptionalString(raw);
	if (!model) return null;
	return {
		model,
		matchKey: match.matchKey,
		matchSource: match.matchSource
	};
}
function resolveChannelModelOverride(params) {
	const channel = normalizeOptionalString(params.channel);
	if (!channel) return null;
	const modelByChannel = params.cfg.channels?.modelByChannel;
	if (!modelByChannel) return null;
	const providerEntries = resolveProviderEntry(modelByChannel, channel);
	if (!providerEntries) return null;
	const directMatch = resolveDirectChannelModelMatch({
		channel,
		providerEntries,
		groupId: params.groupId,
		parentSessionKey: params.parentSessionKey
	});
	if (directMatch) return {
		channel: normalizeMessageChannel(channel) ?? normalizeOptionalLowercaseString(channel) ?? "",
		model: directMatch.model,
		matchKey: directMatch.matchKey,
		matchSource: directMatch.matchSource
	};
	const { keys, parentKeys } = buildChannelCandidates(params);
	if (keys.length === 0 && parentKeys.length === 0) {
		const wildcardModel = normalizeOptionalString(providerEntries["*"]);
		if (wildcardModel) return {
			channel: normalizeMessageChannel(channel) ?? normalizeOptionalLowercaseString(channel) ?? "",
			model: wildcardModel,
			matchKey: "*",
			matchSource: "wildcard"
		};
		return null;
	}
	const match = resolveChannelEntryMatchWithFallback({
		entries: providerEntries,
		keys,
		parentKeys,
		wildcardKey: "*",
		normalizeKey: (value) => normalizeOptionalLowercaseString(value) ?? ""
	});
	const raw = match.entry ?? match.wildcardEntry;
	if (typeof raw !== "string") return null;
	const model = normalizeOptionalString(raw);
	if (!model) return null;
	return {
		channel: normalizeMessageChannel(channel) ?? normalizeOptionalLowercaseString(channel) ?? "",
		model,
		matchKey: match.matchKey,
		matchSource: match.matchSource
	};
}
//#endregion
export { resolveChannelModelOverride as t };
