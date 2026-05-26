import { t as resolvePluginWebSearchProviders } from "./web-search-providers.runtime.js";
import { t as resolvePluginWebFetchProviders } from "./web-fetch-providers.runtime.js";
//#region src/secrets/runtime-web-tools-fallback.runtime.ts
const runtimeWebToolsFallbackProviders = {
	resolvePluginWebFetchProviders,
	resolvePluginWebSearchProviders
};
//#endregion
export { runtimeWebToolsFallbackProviders };
