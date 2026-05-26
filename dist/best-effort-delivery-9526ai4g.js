import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./message-channel-core-BoUoCGOD.js";
import { s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { h as stringifyRouteThreadId } from "./channel-route-L2PJ-xNE.js";
//#region src/infra/outbound/best-effort-delivery.ts
function resolveExternalBestEffortDeliveryTarget(params) {
	const normalizedChannel = normalizeMessageChannel(params.channel);
	const channel = normalizedChannel && isDeliverableMessageChannel(normalizedChannel) ? normalizedChannel : void 0;
	const to = normalizeOptionalString(params.to);
	const deliver = Boolean(channel && to);
	return {
		deliver,
		channel: deliver ? channel : void 0,
		to: deliver ? to : void 0,
		accountId: deliver ? normalizeOptionalString(params.accountId) : void 0,
		threadId: deliver && params.threadId != null && params.threadId !== "" ? stringifyRouteThreadId(params.threadId) : void 0
	};
}
function shouldDowngradeDeliveryToSessionOnly(params) {
	return params.wantsDelivery && params.bestEffortDeliver && params.resolvedChannel === "webchat";
}
//#endregion
export { shouldDowngradeDeliveryToSessionOnly as n, resolveExternalBestEffortDeliveryTarget as t };
