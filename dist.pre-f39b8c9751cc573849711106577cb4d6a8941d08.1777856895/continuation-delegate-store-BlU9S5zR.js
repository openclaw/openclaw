import { a as consumeStagedPostCompactionDelegates$1, f as stagePostCompactionDelegate$1 } from "./delegate-store-cA5uBg4A.js";
//#region src/auto-reply/continuation-delegate-store.ts
function stagePostCompactionDelegate(sessionKey, delegate) {
	const stagedAt = delegate.createdAt ?? Date.now();
	stagePostCompactionDelegate$1(sessionKey, {
		task: delegate.task,
		stagedAt,
		firstArmedAt: delegate.firstArmedAt ?? stagedAt
	});
}
function consumeStagedPostCompactionDelegates(sessionKey) {
	const now = Date.now();
	return consumeStagedPostCompactionDelegates$1(sessionKey).map((d) => {
		const firstArmedAt = d.firstArmedAt ?? now;
		return {
			task: d.task,
			createdAt: firstArmedAt,
			firstArmedAt,
			silent: true,
			silentWake: true
		};
	});
}
//#endregion
export { stagePostCompactionDelegate as n, consumeStagedPostCompactionDelegates as t };
