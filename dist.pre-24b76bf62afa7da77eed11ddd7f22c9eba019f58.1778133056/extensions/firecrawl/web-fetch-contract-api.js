import { t as enablePluginInConfig } from "../../provider-enable-config-CyPMM2ik.js";
import { t as FIRECRAWL_WEB_FETCH_PROVIDER_SHARED } from "../../firecrawl-fetch-provider-shared-DEVf2gHy.js";
//#region extensions/firecrawl/web-fetch-contract-api.ts
function createFirecrawlWebFetchProvider() {
	return {
		...FIRECRAWL_WEB_FETCH_PROVIDER_SHARED,
		applySelectionConfig: (config) => enablePluginInConfig(config, "firecrawl").config,
		createTool: () => null
	};
}
//#endregion
export { createFirecrawlWebFetchProvider };
