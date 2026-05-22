import { r as loadBundledPluginPublicSurfaceModuleSync } from "../facade-loader-CEuC9fQG.js";
//#region src/plugin-sdk/telegram-account.ts
function loadTelegramAccountFacadeModule() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "telegram",
		artifactBasename: "api.js"
	});
}
/**
* @deprecated Compatibility facade for plugin code that needs Telegram account resolution.
* New channel plugins should prefer injected runtime helpers and generic SDK subpaths.
*/
function resolveTelegramAccount(params) {
	return loadTelegramAccountFacadeModule().resolveTelegramAccount(params);
}
//#endregion
export { resolveTelegramAccount };
