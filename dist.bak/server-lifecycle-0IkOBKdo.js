import { S as ensureChromeExtensionRelayServer } from "./chrome-SNeFUnD_.js";
import { a as resolveProfile, n as listKnownProfileNames, t as createBrowserRouteContext } from "./server-context-BLhOGtRw.js";

//#region src/browser/server-lifecycle.ts
async function ensureExtensionRelayForProfiles(params) {
	for (const name of Object.keys(params.resolved.profiles)) {
		const profile = resolveProfile(params.resolved, name);
		if (!profile || profile.driver !== "extension") continue;
		await ensureChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }).catch((err) => {
			params.onWarn(`Chrome extension relay init failed for profile "${name}": ${String(err)}`);
		});
	}
}
async function stopKnownBrowserProfiles(params) {
	const current = params.getState();
	if (!current) return;
	const ctx = createBrowserRouteContext({
		getState: params.getState,
		refreshConfigFromDisk: true
	});
	try {
		for (const name of listKnownProfileNames(current)) try {
			await ctx.forProfile(name).stopRunningBrowser();
		} catch {}
	} catch (err) {
		params.onWarn(`openclaw browser stop failed: ${String(err)}`);
	}
}

//#endregion
export { stopKnownBrowserProfiles as n, ensureExtensionRelayForProfiles as t };