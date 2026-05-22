import { O as parseSessionThreadInfoFast } from "./store-load-DM26fo1a.js";
//#region src/auto-reply/reply/routed-delivery-thread.ts
function resolveRoutedDeliveryThreadId(params) {
	if (params.ctx.MessageThreadId != null) return params.ctx.MessageThreadId;
	if (params.ctx.TransportThreadId != null) return params.ctx.TransportThreadId;
	return parseSessionThreadInfoFast(params.sessionKey).threadId;
}
//#endregion
export { resolveRoutedDeliveryThreadId as t };
