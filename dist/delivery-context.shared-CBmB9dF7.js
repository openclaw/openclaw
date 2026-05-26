import { r as normalizeOptionalAccountId } from "./account-id-B32J-iNN.js";
import { n as normalizeMessageChannel } from "./message-channel-core-BoUoCGOD.js";
import { a as channelRouteTarget, c as channelRouteThreadId, d as normalizeChannelRouteRef, f as normalizeChannelRouteTarget, t as channelRouteCompactKey } from "./channel-route-L2PJ-xNE.js";
//#region src/utils/account-id.ts
function normalizeAccountId(value) {
	return normalizeOptionalAccountId(value);
}
//#endregion
//#region src/utils/delivery-context.shared.ts
function normalizeDeliveryContext(context) {
	if (!context) return;
	const route = normalizeChannelRouteTarget({
		channel: typeof context.channel === "string" ? normalizeMessageChannel(context.channel) ?? context.channel.trim() : void 0,
		to: context.to,
		accountId: context.accountId,
		threadId: context.threadId
	});
	if (!route) return;
	const normalized = {
		channel: route.channel,
		to: channelRouteTarget(route),
		accountId: normalizeAccountId(route.accountId)
	};
	const threadId = channelRouteThreadId(route);
	if (threadId != null) normalized.threadId = threadId;
	return normalized;
}
function normalizeDeliveryChannelRoute(route) {
	if (!route || typeof route !== "object" || Array.isArray(route)) return;
	const candidate = route;
	return normalizeChannelRouteRef({
		channel: candidate.channel,
		to: candidate.target?.to,
		rawTo: candidate.target?.rawTo,
		chatType: candidate.target?.chatType,
		accountId: candidate.accountId,
		threadId: candidate.thread?.id,
		threadKind: candidate.thread?.kind,
		threadSource: candidate.thread?.source
	});
}
function deliveryContextFromChannelRoute(route) {
	const normalized = normalizeDeliveryChannelRoute(route);
	return normalizeDeliveryContext({
		channel: normalized?.channel,
		to: channelRouteTarget(normalized),
		accountId: normalized?.accountId,
		threadId: channelRouteThreadId(normalized)
	});
}
function channelRouteFromDeliveryContext(context) {
	return normalizeChannelRouteTarget(normalizeDeliveryContext(context));
}
function mergeRouteMetadataWithDeliveryContext(route, context) {
	if (!route) return channelRouteFromDeliveryContext(context);
	return normalizeChannelRouteRef({
		channel: route.channel ?? context.channel,
		to: route.target?.to ?? context.to,
		rawTo: route.target?.rawTo,
		chatType: route.target?.chatType,
		accountId: route.accountId ?? context.accountId,
		threadId: route.thread?.id ?? context.threadId,
		threadKind: route.thread?.kind,
		threadSource: route.thread?.source
	});
}
function normalizeSessionDeliveryFields(source) {
	if (!source) return {
		route: void 0,
		deliveryContext: void 0,
		lastChannel: void 0,
		lastTo: void 0,
		lastAccountId: void 0,
		lastThreadId: void 0
	};
	const normalizedRoute = normalizeDeliveryChannelRoute(source.route);
	const merged = mergeDeliveryContext(deliveryContextFromChannelRoute(normalizedRoute), mergeDeliveryContext(normalizeDeliveryContext({
		channel: source.lastChannel ?? source.channel,
		to: source.lastTo,
		accountId: source.lastAccountId,
		threadId: source.lastThreadId
	}), normalizeDeliveryContext(source.deliveryContext)));
	if (!merged) return {
		route: void 0,
		deliveryContext: void 0,
		lastChannel: void 0,
		lastTo: void 0,
		lastAccountId: void 0,
		lastThreadId: void 0
	};
	return {
		route: mergeRouteMetadataWithDeliveryContext(normalizedRoute, merged),
		deliveryContext: merged,
		lastChannel: merged.channel,
		lastTo: merged.to,
		lastAccountId: merged.accountId,
		lastThreadId: merged.threadId
	};
}
function deliveryContextFromSession(entry) {
	if (!entry) return;
	return normalizeSessionDeliveryFields({
		route: entry.route,
		channel: entry.channel ?? entry.origin?.provider,
		lastChannel: entry.lastChannel,
		lastTo: entry.lastTo,
		lastAccountId: entry.lastAccountId ?? entry.origin?.accountId,
		lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
		origin: entry.origin,
		deliveryContext: entry.deliveryContext
	}).deliveryContext;
}
function mergeDeliveryContext(primary, fallback) {
	const normalizedPrimary = normalizeDeliveryContext(primary);
	const normalizedFallback = normalizeDeliveryContext(fallback);
	if (!normalizedPrimary && !normalizedFallback) return;
	const channelsConflict = normalizedPrimary?.channel && normalizedFallback?.channel && normalizedPrimary.channel !== normalizedFallback.channel;
	return normalizeDeliveryContext({
		channel: normalizedPrimary?.channel ?? normalizedFallback?.channel,
		to: channelsConflict ? normalizedPrimary?.to : normalizedPrimary?.to ?? normalizedFallback?.to,
		accountId: channelsConflict ? normalizedPrimary?.accountId : normalizedPrimary?.accountId ?? normalizedFallback?.accountId,
		threadId: channelsConflict ? normalizedPrimary?.threadId : normalizedPrimary?.threadId ?? normalizedFallback?.threadId
	});
}
function deliveryContextKey(context) {
	return channelRouteCompactKey(normalizeDeliveryContext(context));
}
//#endregion
export { normalizeDeliveryChannelRoute as a, normalizeAccountId as c, mergeDeliveryContext as i, deliveryContextFromSession as n, normalizeDeliveryContext as o, deliveryContextKey as r, normalizeSessionDeliveryFields as s, deliveryContextFromChannelRoute as t };
