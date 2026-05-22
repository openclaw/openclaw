//#region src/channels/turn/dispatch-result.ts
const EMPTY_CHANNEL_TURN_DISPATCH_COUNTS = {
	tool: 0,
	block: 0,
	final: 0
};
function resolveChannelTurnDispatchCounts(result) {
	return {
		...EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
		...result?.counts
	};
}
function hasVisibleChannelTurnDispatch(result, signals = {}) {
	const counts = resolveChannelTurnDispatchCounts(result);
	return signals.observedReplyDelivery === true || signals.fallbackDelivered === true || signals.deliverySummaryDelivered === true || result?.queuedFinal === true || counts.tool > 0 || counts.block > 0 || counts.final > 0;
}
function hasFinalChannelTurnDispatch(result, signals = {}) {
	const counts = resolveChannelTurnDispatchCounts(result);
	return signals.fallbackDelivered === true || signals.deliverySummaryDelivered === true || result?.queuedFinal === true || counts.final > 0;
}
//#endregion
export { resolveChannelTurnDispatchCounts as i, hasFinalChannelTurnDispatch as n, hasVisibleChannelTurnDispatch as r, EMPTY_CHANNEL_TURN_DISPATCH_COUNTS as t };
