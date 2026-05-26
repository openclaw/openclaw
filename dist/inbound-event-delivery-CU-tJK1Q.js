import { o as stripTelegramInternalPrefixes } from "./targets-D0gFWyUZ.js";
//#region extensions/telegram/src/inbound-event-delivery.ts
const registry = /* @__PURE__ */ new Map();
function normalizeTelegramDeliveryTarget(value) {
	return stripTelegramInternalPrefixes(value).toLowerCase();
}
function stripTelegramTopicTarget(value) {
	return value.replace(/:topic:\d+$/u, "");
}
function hasTelegramTopicTarget(value) {
	return /:topic:\d+$/u.test(value);
}
function telegramDeliveryTargetsMatch(expected, actual) {
	const expectedTarget = normalizeTelegramDeliveryTarget(expected);
	const actualTarget = normalizeTelegramDeliveryTarget(actual);
	if (expectedTarget === actualTarget) return true;
	if (hasTelegramTopicTarget(expectedTarget)) return false;
	const expectedBase = stripTelegramTopicTarget(expectedTarget);
	const actualBase = stripTelegramTopicTarget(actualTarget);
	return expectedBase === actualBase && (expectedTarget === expectedBase || actualTarget === actualBase);
}
function resolveTelegramInboundEventDeliveryCorrelationKey(sessionKey, inboundEventKind) {
	const key = sessionKey?.trim();
	if (!key) return;
	return inboundEventKind === "room_event" ? `${key}:room_event` : key;
}
function beginTelegramInboundEventDeliveryCorrelation(sessionKey, event, options) {
	const key = resolveTelegramInboundEventDeliveryCorrelationKey(sessionKey, options?.inboundEventKind);
	if (!key) return () => {};
	registry.set(key, event);
	return () => {
		if (registry.get(key) === event) registry.delete(key);
	};
}
function notifyTelegramInboundEventOutboundSuccess(params) {
	const key = resolveTelegramInboundEventDeliveryCorrelationKey(params.sessionKey, params.inboundEventKind);
	if (!key) return;
	const event = registry.get(key);
	if (!event || !telegramDeliveryTargetsMatch(event.outboundTo, params.to)) return;
	if (event.outboundAccountId && params.accountId && params.accountId !== event.outboundAccountId) return;
	event.markInboundEventDelivered();
}
//#endregion
export { notifyTelegramInboundEventOutboundSuccess as n, beginTelegramInboundEventDeliveryCorrelation as t };
