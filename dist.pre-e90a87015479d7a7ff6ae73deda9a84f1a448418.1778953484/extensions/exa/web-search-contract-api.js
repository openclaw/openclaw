import { t as createExaWebSearchProviderBase } from "../../exa-web-search-provider.shared-DxGR9rx7.js";
//#region extensions/exa/web-search-contract-api.ts
function createExaWebSearchProvider() {
	return {
		...createExaWebSearchProviderBase(),
		createTool: () => null
	};
}
//#endregion
export { createExaWebSearchProvider };
