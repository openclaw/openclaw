import { o as resolvePerplexityWebSearchRuntimeMetadata, r as createPerplexityWebSearchProviderBase } from "../../perplexity-web-search-provider.shared-aHUBiqqB.js";
//#region extensions/perplexity/web-search-contract-api.ts
function createPerplexityWebSearchProvider() {
	return {
		...createPerplexityWebSearchProviderBase(),
		resolveRuntimeMetadata: resolvePerplexityWebSearchRuntimeMetadata,
		createTool: () => null
	};
}
//#endregion
export { createPerplexityWebSearchProvider };
