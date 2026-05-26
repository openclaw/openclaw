import { o as resolvePerplexityWebSearchRuntimeMetadata, r as createPerplexityWebSearchProviderBase } from "../../perplexity-web-search-provider.shared-Dgmwb0iq.js";
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
