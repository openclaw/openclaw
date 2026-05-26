//#region extensions/telegram/src/inbound-turn-delivery.ts
const registry = /* @__PURE__ */ new Map();
function beginTelegramInboundTurnDeliveryCorrelation(sessionKey, turn) {
	const key = sessionKey?.trim();
	if (!key) return () => {};
	registry.set(key, turn);
	return () => {
		registry.delete(key);
	};
}
function notifyTelegramInboundTurnOutboundSuccess(params) {
	const key = params.sessionKey?.trim();
	if (!key) return;
	const turn = registry.get(key);
	if (!turn || turn.outboundTo !== params.to) return;
	if (turn.outboundAccountId && params.accountId && params.accountId !== turn.outboundAccountId) return;
	turn.markInboundTurnDelivered();
}
//#endregion
export { notifyTelegramInboundTurnOutboundSuccess as n, beginTelegramInboundTurnDeliveryCorrelation as t };
