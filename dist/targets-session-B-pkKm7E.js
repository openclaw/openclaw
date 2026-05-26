import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as getActivePluginChannelRegistryFromState } from "./runtime-channel-state-CQNj7c3E.js";
import { n as normalizeMessageChannel, t as isDeliverableMessageChannel } from "./message-channel-core-BoUoCGOD.js";
import { s as channelRouteTargetsShareConversation } from "./channel-route-L2PJ-xNE.js";
import { n as deliveryContextFromSession } from "./delivery-context.shared-CBmB9dF7.js";
import { m as mapAllowFromEntries } from "./channel-config-helpers-xZ4-bv2H.js";
import { n as missingTargetError } from "./target-errors-Cjh6i-kG.js";
import { n as resolveRouteTargetForLoadedChannel, t as parseExplicitTargetForLoadedChannel } from "./target-parsing-loaded-iZGz63Hr.js";
//#region src/infra/outbound/channel-target-prefix.ts
const TARGET_KIND_PREFIXES = new Set([
	"channel",
	"conversation",
	"dm",
	"group",
	"room",
	"thread",
	"user"
]);
function resolvePluginTargetPrefix(prefix) {
	const normalizedPrefix = normalizeOptionalLowercaseString(prefix);
	if (!normalizedPrefix) return;
	const registry = getActivePluginChannelRegistryFromState();
	for (const entry of registry?.channels ?? []) {
		const plugin = entry.plugin;
		const channelId = normalizeOptionalLowercaseString(plugin.id);
		const candidates = plugin.messaging?.targetPrefixes ?? [];
		if (channelId && candidates.some((candidate) => normalizeOptionalLowercaseString(candidate) === normalizedPrefix)) return channelId;
	}
}
function resolveChannelTargetProviderPrefix(raw) {
	const prefix = normalizeOptionalLowercaseString(/^\s*([a-z][a-z0-9_-]*):/i.exec(raw ?? "")?.[1]);
	if (!prefix || TARGET_KIND_PREFIXES.has(prefix)) return;
	const channel = resolvePluginTargetPrefix(prefix);
	return channel ? {
		prefix,
		channel
	} : void 0;
}
function resolveTargetPrefixedChannel(raw) {
	return resolveChannelTargetProviderPrefix(raw)?.channel;
}
function validateTargetProviderPrefix(params) {
	const selectedChannel = normalizeMessageChannel(params.channel) ?? normalizeOptionalLowercaseString(params.channel);
	if (!selectedChannel || selectedChannel === "last") return;
	const prefixed = resolveChannelTargetProviderPrefix(params.to);
	if (!prefixed || prefixed.channel === selectedChannel) return;
	return /* @__PURE__ */ new Error(`Target prefix "${prefixed.prefix}:" belongs to ${prefixed.channel}, not ${selectedChannel}.`);
}
//#endregion
//#region src/infra/outbound/targets-resolve-shared.ts
function buildWebChatDeliveryError() {
	return /* @__PURE__ */ new Error(`Delivering to WebChat is not supported via \`${formatCliCommand("openclaw agent")}\`; use WhatsApp/Telegram or run with --deliver=false.`);
}
function resolveOutboundTargetWithPlugin(params) {
	if (params.target.channel === "webchat") return {
		ok: false,
		error: buildWebChatDeliveryError()
	};
	const plugin = params.plugin;
	if (!plugin) return params.onMissingPlugin?.();
	const allowFromRaw = params.target.allowFrom ?? (params.target.cfg && plugin.config.resolveAllowFrom ? plugin.config.resolveAllowFrom({
		cfg: params.target.cfg,
		accountId: params.target.accountId ?? void 0
	}) : void 0);
	const allowFrom = allowFromRaw ? mapAllowFromEntries(allowFromRaw) : void 0;
	const effectiveTo = params.target.to?.trim() || (params.target.cfg && plugin.config.resolveDefaultTo ? plugin.config.resolveDefaultTo({
		cfg: params.target.cfg,
		accountId: params.target.accountId ?? void 0
	}) : void 0);
	const targetPrefixError = validateTargetProviderPrefix({
		channel: params.target.channel,
		to: effectiveTo
	});
	if (targetPrefixError) return {
		ok: false,
		error: targetPrefixError
	};
	const resolveTarget = plugin.outbound?.resolveTarget;
	if (resolveTarget) return resolveTarget({
		cfg: params.target.cfg,
		to: effectiveTo,
		allowFrom,
		accountId: params.target.accountId ?? void 0,
		mode: params.target.mode ?? "explicit"
	});
	if (effectiveTo) return {
		ok: true,
		to: effectiveTo
	};
	const hint = plugin.messaging?.targetResolver?.hint;
	return {
		ok: false,
		error: missingTargetError(plugin.meta.label ?? params.target.channel, hint)
	};
}
//#endregion
//#region src/infra/outbound/targets-session.ts
function parseExplicitTargetWithPlugin(params) {
	const raw = params.raw?.trim();
	if (!raw) return null;
	const provider = params.channel ?? params.fallbackChannel;
	if (!provider) return null;
	return parseExplicitTargetForLoadedChannel(provider, raw);
}
function resolveSessionDeliveryTarget(params) {
	const context = deliveryContextFromSession(params.entry);
	const sessionLastChannel = context?.channel && isDeliverableMessageChannel(context.channel) ? context.channel : void 0;
	const parsedSessionTarget = sessionLastChannel ? resolveRouteTargetForLoadedChannel({
		channel: sessionLastChannel,
		rawTarget: context?.to,
		fallbackThreadId: context?.threadId
	}) : null;
	const hasTurnSourceChannel = params.turnSourceChannel != null;
	const parsedTurnSourceTarget = hasTurnSourceChannel && params.turnSourceChannel ? resolveRouteTargetForLoadedChannel({
		channel: params.turnSourceChannel,
		rawTarget: params.turnSourceTo,
		fallbackThreadId: params.turnSourceThreadId
	}) : null;
	const hasTurnSourceThreadId = parsedTurnSourceTarget?.threadId != null;
	const lastChannel = hasTurnSourceChannel ? params.turnSourceChannel : sessionLastChannel;
	const lastTo = hasTurnSourceChannel ? params.turnSourceTo : context?.to;
	const lastAccountId = hasTurnSourceChannel ? params.turnSourceAccountId : context?.accountId;
	const turnToMatchesSession = !params.turnSourceTo || !context?.to || params.turnSourceChannel === sessionLastChannel && channelRouteTargetsShareConversation({
		left: parsedTurnSourceTarget,
		right: parsedSessionTarget
	});
	const lastThreadId = hasTurnSourceThreadId ? parsedTurnSourceTarget?.threadId : hasTurnSourceChannel && (params.turnSourceChannel !== sessionLastChannel || !turnToMatchesSession) ? void 0 : parsedSessionTarget?.threadId;
	const rawRequested = params.requestedChannel ?? "last";
	const requested = rawRequested === "last" ? "last" : normalizeMessageChannel(rawRequested);
	const requestedChannel = requested === "last" ? "last" : requested && isDeliverableMessageChannel(requested) ? requested : void 0;
	const rawExplicitTo = typeof params.explicitTo === "string" && params.explicitTo.trim() ? params.explicitTo.trim() : void 0;
	const explicitPrefixedChannel = requestedChannel === "last" ? resolveTargetPrefixedChannel(rawExplicitTo) : void 0;
	let channel = explicitPrefixedChannel && isDeliverableMessageChannel(explicitPrefixedChannel) ? explicitPrefixedChannel : requestedChannel === "last" ? lastChannel : requestedChannel;
	if (!channel && params.fallbackChannel && isDeliverableMessageChannel(params.fallbackChannel)) channel = params.fallbackChannel;
	let explicitTo = rawExplicitTo;
	const parsedExplicitTarget = parseExplicitTargetWithPlugin({
		channel,
		fallbackChannel: !channel ? lastChannel : void 0,
		raw: rawExplicitTo
	});
	if (parsedExplicitTarget?.to) explicitTo = parsedExplicitTarget.to;
	const explicitThreadId = params.explicitThreadId != null && params.explicitThreadId !== "" ? params.explicitThreadId : parsedExplicitTarget?.threadId;
	let to = explicitTo;
	if (!to && lastTo) {
		if (channel && channel === lastChannel) to = lastTo;
		else if (params.allowMismatchedLastTo) to = lastTo;
	}
	const mode = params.mode ?? (explicitTo ? "explicit" : "implicit");
	const accountId = channel && channel === lastChannel ? lastAccountId : void 0;
	const threadId = channel && channel === lastChannel ? mode === "heartbeat" ? hasTurnSourceThreadId ? params.turnSourceThreadId : void 0 : lastThreadId : void 0;
	const resolvedThreadId = explicitThreadId ?? threadId;
	return {
		channel,
		to,
		accountId,
		threadId: resolvedThreadId,
		threadIdExplicit: resolvedThreadId != null && explicitThreadId != null,
		mode,
		lastChannel,
		lastTo,
		lastAccountId,
		lastThreadId
	};
}
//#endregion
export { validateTargetProviderPrefix as i, resolveOutboundTargetWithPlugin as n, resolveTargetPrefixedChannel as r, resolveSessionDeliveryTarget as t };
