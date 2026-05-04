import {
  enablePluginInConfig,
  type WebFetchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-fetch-contract";
import { TAVILY_WEB_FETCH_PROVIDER_SHARED } from "./src/tavily-fetch-provider-shared.js";

export function createTavilyWebFetchProvider(): WebFetchProviderPlugin {
  return {
    ...TAVILY_WEB_FETCH_PROVIDER_SHARED,
    applySelectionConfig: (config) => enablePluginInConfig(config, "tavily").config,
    createTool: () => null,
  };
}
