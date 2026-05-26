import { r as loadBundledPluginPublicSurfaceModuleSync } from "../facade-loader-Cog8gw3V.js";
//#region src/plugin-sdk/provider-zai-endpoint.ts
/**
* @deprecated Z.AI provider-owned endpoint detection helper. Use the bundled
* Z.AI plugin public API instead, or keep endpoint probing local to your
* provider plugin.
*/
function loadFacadeModule() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "zai",
		artifactBasename: "api.js"
	});
}
/** @deprecated Z.AI provider-owned endpoint detection helper. */
const detectZaiEndpoint = ((...args) => loadFacadeModule().detectZaiEndpoint(...args));
//#endregion
export { detectZaiEndpoint };
