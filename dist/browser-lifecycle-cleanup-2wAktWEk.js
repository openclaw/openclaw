import { t as closeTrackedBrowserTabsForSessions } from "./browser-maintenance-CIdUceQj.js";
//#region src/infra/non-fatal-cleanup.ts
async function runBestEffortCleanup(params) {
	try {
		return await params.cleanup();
	} catch (error) {
		params.onError?.(error);
		return;
	}
}
//#endregion
//#region src/browser-lifecycle-cleanup.ts
function normalizeSessionKeys(sessionKeys) {
	const keys = /* @__PURE__ */ new Set();
	for (const sessionKey of sessionKeys) {
		const normalized = sessionKey.trim();
		if (normalized) keys.add(normalized);
	}
	return [...keys];
}
async function cleanupBrowserSessionsForLifecycleEnd(params) {
	const sessionKeys = normalizeSessionKeys(params.sessionKeys);
	if (sessionKeys.length === 0) return;
	await runBestEffortCleanup({
		cleanup: async () => {
			await closeTrackedBrowserTabsForSessions({
				sessionKeys,
				onWarn: params.onWarn
			});
		},
		onError: params.onError
	});
}
//#endregion
export { cleanupBrowserSessionsForLifecycleEnd as t };
