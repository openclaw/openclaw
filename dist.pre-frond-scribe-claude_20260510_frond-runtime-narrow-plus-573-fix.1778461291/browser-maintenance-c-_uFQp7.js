import { r as loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader-Dadyko8Y.js";
import "./browser-trash-B2pb1SMc.js";
//#region src/plugin-sdk/browser-maintenance.ts
let cachedBrowserMaintenanceSurface;
function hasRequestedSessionKeys(sessionKeys) {
	return sessionKeys.some((key) => Boolean(key?.trim()));
}
function loadBrowserMaintenanceSurface() {
	cachedBrowserMaintenanceSurface ??= loadBundledPluginPublicSurfaceModuleSync({
		dirName: "browser",
		artifactBasename: "browser-maintenance.js"
	});
	return cachedBrowserMaintenanceSurface;
}
async function closeTrackedBrowserTabsForSessions(params) {
	if (!hasRequestedSessionKeys(params.sessionKeys)) return 0;
	let surface;
	try {
		surface = loadBrowserMaintenanceSurface();
	} catch (error) {
		params.onWarn?.(`browser cleanup unavailable: ${String(error)}`);
		return 0;
	}
	return await surface.closeTrackedBrowserTabsForSessions(params);
}
//#endregion
export { closeTrackedBrowserTabsForSessions as t };
