import { a as consumeStagedPostCompactionDelegates$1, f as stagePostCompactionDelegate$1 } from "./delegate-store-DNb-sMEv.js";
//#region src/auto-reply/continuation-delegate-store.ts
function stagePostCompactionDelegate(sessionKey, delegate) {
	const stagedAt = delegate.createdAt ?? Date.now();
	stagePostCompactionDelegate$1(sessionKey, {
		task: delegate.task,
		stagedAt,
		firstArmedAt: delegate.firstArmedAt ?? stagedAt,
		...delegate.targetSessionKey ? { targetSessionKey: delegate.targetSessionKey } : {},
		...delegate.targetSessionKeys ? { targetSessionKeys: delegate.targetSessionKeys } : {},
		...delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {},
		...delegate.traceparent ? { traceparent: delegate.traceparent } : {}
	});
}
function consumeStagedPostCompactionDelegates(sessionKey) {
	const now = Date.now();
	return consumeStagedPostCompactionDelegates$1(sessionKey).map((d) => {
		const firstArmedAt = d.firstArmedAt ?? now;
		const delegate = {
			task: d.task,
			createdAt: firstArmedAt,
			firstArmedAt,
			silent: true,
			silentWake: true
		};
		if (d.targetSessionKey) delegate.targetSessionKey = d.targetSessionKey;
		if (d.targetSessionKeys) delegate.targetSessionKeys = d.targetSessionKeys;
		if (d.fanoutMode) delegate.fanoutMode = d.fanoutMode;
		if (d.traceparent) delegate.traceparent = d.traceparent;
		return delegate;
	});
}
//#endregion
export { stagePostCompactionDelegate as n, consumeStagedPostCompactionDelegates as t };
