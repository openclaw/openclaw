import { d as normalizeChannelRouteRef } from "./channel-route-L2PJ-xNE.js";
import { t as deliveryContextFromChannelRoute } from "./delivery-context.shared-CBmB9dF7.js";
import { n as resolveConversationDeliveryTarget } from "./delivery-context-B4XSfAAB.js";
//#region src/channels/route-projection.ts
function deliveryContextFromRoute(route) {
	return deliveryContextFromChannelRoute(route);
}
function routeFromConversationRef(conversation) {
	if (!conversation) return;
	const target = resolveConversationDeliveryTarget({
		channel: conversation.channel,
		conversationId: conversation.conversationId,
		parentConversationId: conversation.parentConversationId
	});
	return normalizeChannelRouteRef({
		channel: conversation.channel,
		accountId: conversation.accountId,
		to: target.to,
		threadId: target.threadId,
		threadSource: target.threadId ? "target" : void 0
	});
}
function routeFromBindingRecord(binding) {
	return routeFromConversationRef(binding?.conversation);
}
function routeToDeliveryFields(route) {
	const deliveryContext = deliveryContextFromRoute(route);
	return {
		...deliveryContext ? { deliveryContext } : {},
		...deliveryContext?.channel ? { channel: deliveryContext.channel } : {},
		...deliveryContext?.to ? { to: deliveryContext.to } : {},
		...deliveryContext?.accountId ? { accountId: deliveryContext.accountId } : {},
		...deliveryContext?.threadId != null ? { threadId: deliveryContext.threadId } : {}
	};
}
//#endregion
export { routeFromConversationRef as n, routeToDeliveryFields as r, routeFromBindingRecord as t };
