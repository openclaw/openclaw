import {
  enablePluginInConfig,
  type WebFetchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-fetch-contract";
import { TINYFISH_WEB_FETCH_PROVIDER_SHARED } from "./src/tinyfish-fetch-provider-shared.js";

export function createTinyFishWebFetchProvider(): WebFetchProviderPlugin {
  return {
    ...TINYFISH_WEB_FETCH_PROVIDER_SHARED,
    applySelectionConfig: (config) => enablePluginInConfig(config, "tinyfish").config,
    createTool: () => null,
  };
}
