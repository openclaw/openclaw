import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { r as normalizeChatChannelId } from "./ids-BE_yccbC.js";
import { a as normalizeAnyChannelId } from "./registry-CtWyD2pE.js";
import { t as getActivePluginChannelRegistry } from "./runtime-DHxRl5F1.js";
import { h as stringifyRouteThreadId } from "./channel-route-L2PJ-xNE.js";
import { a as normalizeChannelId, n as getLoadedChannelPlugin, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { r as normalizeConversationTargetRef } from "./session-binding-normalization-D9PNZGcW.js";
import { t as resolveConversationIdFromTargets } from "./conversation-id-CW0vVUEs.js";
import { n as resolveBundledChannelThreadBindingInboundConversation, t as resolveBundledChannelThreadBindingDefaultPlacement } from "./thread-binding-api-tBMd1vH5.js";
//#region src/channels/plugins/target-parsing.ts
function parseWithPlugin(getPlugin, rawChannel, rawTarget) {
	const channel = normalizeChatChannelId(rawChannel) ?? normalizeChannelId(rawChannel);
	if (!channel) return null;
	return getPlugin(channel)?.messaging?.parseExplicitTarget?.({ raw: rawTarget }) ?? null;
}
function parseExplicitTargetForChannel(channel, rawTarget) {
	return parseWithPlugin(getChannelPlugin, channel, rawTarget);
}
//#endregion
//#region src/channels/conversation-resolution.ts
const CANONICAL_TARGET_PREFIXES = ["user:", "spaces/"];
function resolveChannelId(raw) {
	const normalizedRaw = normalizeOptionalString(raw);
	if (!normalizedRaw) return null;
	return normalizeAnyChannelId(normalizedRaw) ?? normalizeChannelId(normalizedRaw) ?? normalizeOptionalLowercaseString(normalizedRaw) ?? null;
}
function getActiveRegistryChannelPlugin(rawChannel) {
	const normalized = normalizeAnyChannelId(rawChannel) ?? normalizeOptionalString(rawChannel);
	if (!normalized) return;
	return getActivePluginChannelRegistry()?.channels.find((entry) => entry.plugin.id === normalized)?.plugin;
}
function getRuntimeChannelPluginCandidates(channel) {
	const candidates = [getActiveRegistryChannelPlugin(channel), getLoadedChannelPlugin(channel)].filter((plugin) => Boolean(plugin));
	return [...new Map(candidates.map((plugin) => [plugin.id, plugin])).values()];
}
function resolveRuntimeChannelPlugin(channel) {
	return getRuntimeChannelPluginCandidates(channel)[0];
}
function shouldDefaultParentConversationToSelf(plugin) {
	return plugin?.bindings?.selfParentConversationByDefault === true;
}
function normalizeResolutionTarget(params) {
	const conversationId = normalizeOptionalString(params.conversation?.conversationId);
	if (!conversationId) return null;
	const parentConversationId = normalizeOptionalString(params.conversation?.parentConversationId);
	const defaultParentToSelf = shouldDefaultParentConversationToSelf(params.plugin) && !params.threadId && !parentConversationId;
	const normalized = normalizeConversationTargetRef({
		conversationId,
		parentConversationId: defaultParentToSelf ? conversationId : parentConversationId
	});
	const normalizedParentConversationId = defaultParentToSelf ? normalized.conversationId : normalized.parentConversationId;
	const placementHint = params.includePlacementHint === false ? void 0 : resolveChannelDefaultBindingPlacement(params.channel);
	return {
		canonical: {
			channel: params.channel,
			accountId: params.accountId,
			conversationId: normalized.conversationId,
			...normalizedParentConversationId ? { parentConversationId: normalizedParentConversationId } : {}
		},
		...params.threadId ? { threadId: params.threadId } : {},
		...placementHint ? { placementHint } : {},
		source: params.source
	};
}
function resolveBindingAccountId(params) {
	return normalizeOptionalString(params.rawAccountId) || normalizeOptionalString(params.plugin?.config.defaultAccountId?.(params.cfg)) || "default";
}
function resolveChannelTargetId(params) {
	const target = normalizeOptionalString(params.target);
	if (!target) return;
	const lower = normalizeLowercaseStringOrEmpty(target);
	const channelPrefix = `${params.channel}:`;
	if (lower.startsWith(channelPrefix)) return resolveChannelTargetId({
		channel: params.channel,
		target: target.slice(channelPrefix.length)
	});
	if (CANONICAL_TARGET_PREFIXES.some((prefix) => lower.startsWith(prefix))) return target;
	const explicitConversationId = resolveConversationIdFromTargets({ targets: [target] });
	if (explicitConversationId) return explicitConversationId;
	const parsedTarget = normalizeOptionalString(parseExplicitTargetForChannel(params.channel, target)?.to);
	if (parsedTarget) return resolveConversationIdFromTargets({ targets: [parsedTarget] }) ?? parsedTarget;
	return target;
}
function buildThreadingContext(params) {
	const to = normalizeOptionalString(params.originatingTo) ?? normalizeOptionalString(params.fallbackTo);
	return {
		...to ? { To: to } : {},
		...params.from ? { From: params.from } : {},
		...params.chatType ? { ChatType: params.chatType } : {},
		...params.threadId ? { MessageThreadId: params.threadId } : {},
		...params.nativeChannelId ? { NativeChannelId: params.nativeChannelId } : {}
	};
}
function resolveChannelDefaultBindingPlacement(rawChannel) {
	const channel = resolveChannelId(rawChannel);
	if (!channel) return;
	return resolveRuntimeChannelPlugin(channel)?.conversationBindings?.defaultTopLevelPlacement ?? resolveBundledChannelThreadBindingDefaultPlacement(channel);
}
function resolveCommandConversationResolution(params) {
	const channel = resolveChannelId(params.channel);
	if (!channel) return null;
	const plugin = resolveRuntimeChannelPlugin(channel);
	const accountId = resolveBindingAccountId({
		rawAccountId: params.accountId,
		plugin,
		cfg: params.cfg
	});
	const threadId = stringifyRouteThreadId(params.threadId);
	const commandParams = {
		accountId,
		threadId,
		threadParentId: normalizeOptionalString(params.threadParentId),
		senderId: normalizeOptionalString(params.senderId),
		sessionKey: normalizeOptionalString(params.sessionKey),
		parentSessionKey: normalizeOptionalString(params.parentSessionKey),
		from: normalizeOptionalString(params.from),
		chatType: normalizeOptionalString(params.chatType),
		originatingTo: params.originatingTo ?? void 0,
		commandTo: params.commandTo ?? void 0,
		fallbackTo: params.fallbackTo ?? void 0
	};
	const resolvedByProvider = plugin?.bindings?.resolveCommandConversation?.(commandParams);
	const providerResolution = normalizeResolutionTarget({
		channel,
		accountId,
		conversation: resolvedByProvider,
		source: "command-provider",
		threadId,
		plugin,
		includePlacementHint: params.includePlacementHint
	});
	if (providerResolution) return providerResolution;
	const focusedBinding = plugin?.threading?.resolveFocusedBinding?.({
		cfg: params.cfg,
		accountId,
		context: buildThreadingContext({
			fallbackTo: params.fallbackTo ?? void 0,
			originatingTo: params.originatingTo ?? void 0,
			threadId,
			from: normalizeOptionalString(params.from),
			chatType: normalizeOptionalString(params.chatType),
			nativeChannelId: normalizeOptionalString(params.nativeChannelId)
		})
	});
	const focusedResolution = normalizeResolutionTarget({
		channel,
		accountId,
		conversation: focusedBinding,
		source: "focused-binding",
		threadId,
		plugin,
		includePlacementHint: params.includePlacementHint
	});
	if (focusedResolution) return focusedResolution;
	const baseConversationId = resolveChannelTargetId({
		channel,
		target: params.originatingTo
	}) ?? resolveChannelTargetId({
		channel,
		target: params.commandTo
	}) ?? resolveChannelTargetId({
		channel,
		target: params.fallbackTo
	});
	const parentConversationId = resolveChannelTargetId({
		channel,
		target: params.threadParentId
	}) ?? (threadId && baseConversationId && baseConversationId !== threadId ? baseConversationId : void 0);
	const conversationId = threadId || baseConversationId;
	if (!conversationId) return null;
	return normalizeResolutionTarget({
		channel,
		accountId,
		conversation: {
			conversationId,
			parentConversationId
		},
		source: "command-fallback",
		threadId,
		plugin,
		includePlacementHint: params.includePlacementHint
	});
}
function resolveInboundConversationResolution(params) {
	const channel = resolveChannelId(params.channel);
	if (!channel) return null;
	const plugin = resolveRuntimeChannelPlugin(channel);
	const accountId = resolveBindingAccountId({
		rawAccountId: params.accountId,
		plugin,
		cfg: params.cfg
	});
	const threadId = stringifyRouteThreadId(params.threadId);
	const resolverParams = {
		from: normalizeOptionalString(params.from),
		to: normalizeOptionalString(params.to),
		conversationId: normalizeOptionalString(params.conversationId) ?? normalizeOptionalString(params.groupId) ?? normalizeOptionalString(params.to),
		threadId,
		isGroup: params.isGroup ?? true
	};
	const providerConversation = plugin?.messaging?.resolveInboundConversation?.(resolverParams);
	const providerResolution = normalizeResolutionTarget({
		channel,
		accountId,
		conversation: providerConversation,
		source: "inbound-provider",
		threadId,
		plugin
	});
	if (providerResolution || providerConversation === null) return providerResolution;
	const artifactConversation = resolveBundledChannelThreadBindingInboundConversation({
		channelId: channel,
		...resolverParams
	});
	const artifactResolution = normalizeResolutionTarget({
		channel,
		accountId,
		conversation: artifactConversation,
		source: "inbound-bundled-artifact",
		threadId,
		plugin
	});
	if (artifactResolution || artifactConversation === null) return artifactResolution;
	const parentConversationId = resolveChannelTargetId({
		channel,
		target: params.to
	}) ?? resolveChannelTargetId({
		channel,
		target: params.conversationId
	}) ?? resolveChannelTargetId({
		channel,
		target: params.groupId
	});
	const genericConversationId = threadId ?? resolveChannelTargetId({
		channel,
		target: params.conversationId
	}) ?? resolveChannelTargetId({
		channel,
		target: params.groupId
	}) ?? parentConversationId;
	if (!genericConversationId) return null;
	return normalizeResolutionTarget({
		channel,
		accountId,
		conversation: {
			conversationId: genericConversationId,
			parentConversationId: threadId != null ? parentConversationId : void 0
		},
		source: "inbound-fallback",
		threadId,
		plugin
	});
}
//#endregion
export { resolveCommandConversationResolution as n, resolveInboundConversationResolution as r, resolveChannelDefaultBindingPlacement as t };
