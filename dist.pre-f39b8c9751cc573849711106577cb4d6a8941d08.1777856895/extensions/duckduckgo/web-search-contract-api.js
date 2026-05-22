import { t as createDuckDuckGoWebSearchProviderBase } from "../../ddg-search-provider.shared-TiGH3pnc.js";
//#region extensions/duckduckgo/web-search-contract-api.ts
function createDuckDuckGoWebSearchProvider() {
	return {
		...createDuckDuckGoWebSearchProviderBase(),
		createTool: () => null
	};
}
//#endregion
export { createDuckDuckGoWebSearchProvider };
