import {
  enablePluginInConfig,
  type WebFetchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-fetch-contract";
import { APIFY_FETCH_PROVIDER_SHARED } from "./src/apify-fetch-provider-shared.js";

export function createApifyWebFetchProvider(): WebFetchProviderPlugin {
  return {
    ...APIFY_FETCH_PROVIDER_SHARED,
    applySelectionConfig: (config) => enablePluginInConfig(config, "apify").config,
    createTool: () => null,
  };
}
