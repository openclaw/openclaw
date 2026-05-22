import { t as createDuckDuckGoWebSearchProviderBase } from "../../ddg-search-provider.shared-ty84U4TZ.js";
//#region extensions/duckduckgo/web-search-contract-api.ts
function createDuckDuckGoWebSearchProvider() {
	return {
		...createDuckDuckGoWebSearchProviderBase(),
		createTool: () => null
	};
}
//#endregion
export { createDuckDuckGoWebSearchProvider };
