import { et as stripTelegramInternalPrefixes } from "./format-KDh88jY2.js";
//#region extensions/telegram/src/inbound-turn-delivery.ts
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
function resolveTelegramInboundTurnDeliveryCorrelationKey(sessionKey, inboundTurnKind) {
	const key = sessionKey?.trim();
	if (!key) return;
	return inboundTurnKind === "room_event" ? `${key}:room_event` : key;
}
function beginTelegramInboundTurnDeliveryCorrelation(sessionKey, turn, options) {
	const key = resolveTelegramInboundTurnDeliveryCorrelationKey(sessionKey, options?.inboundTurnKind);
	if (!key) return () => {};
	registry.set(key, turn);
	return () => {
		if (registry.get(key) === turn) registry.delete(key);
	};
}
function notifyTelegramInboundTurnOutboundSuccess(params) {
	const key = resolveTelegramInboundTurnDeliveryCorrelationKey(params.sessionKey, params.inboundTurnKind);
	if (!key) return;
	const turn = registry.get(key);
	if (!turn || !telegramDeliveryTargetsMatch(turn.outboundTo, params.to)) return;
	if (turn.outboundAccountId && params.accountId && params.accountId !== turn.outboundAccountId) return;
	turn.markInboundTurnDelivered();
}
//#endregion
export { notifyTelegramInboundTurnOutboundSuccess as n, beginTelegramInboundTurnDeliveryCorrelation as t };
