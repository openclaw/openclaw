import { r as normalizeOptionalAccountId } from "./account-id-CwBWagLE.js";
import { n as normalizeMessageChannel } from "./message-channel-core-Bs-MA2kH.js";
import { a as channelRouteTarget, c as channelRouteThreadId, f as normalizeChannelRouteTarget, t as channelRouteCompactKey } from "./channel-route-jaZFObQA.js";
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
function normalizeSessionDeliveryFields(source) {
	if (!source) return {
		deliveryContext: void 0,
		lastChannel: void 0,
		lastTo: void 0,
		lastAccountId: void 0,
		lastThreadId: void 0
	};
	const merged = mergeDeliveryContext(normalizeDeliveryContext({
		channel: source.lastChannel ?? source.channel,
		to: source.lastTo,
		accountId: source.lastAccountId,
		threadId: source.lastThreadId
	}), normalizeDeliveryContext(source.deliveryContext));
	if (!merged) return {
		deliveryContext: void 0,
		lastChannel: void 0,
		lastTo: void 0,
		lastAccountId: void 0,
		lastThreadId: void 0
	};
	return {
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
export { normalizeSessionDeliveryFields as a, normalizeDeliveryContext as i, deliveryContextKey as n, normalizeAccountId as o, mergeDeliveryContext as r, deliveryContextFromSession as t };
