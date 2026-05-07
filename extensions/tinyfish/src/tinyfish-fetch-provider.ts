import type { WebFetchProviderPlugin } from "openclaw/plugin-sdk/provider-web-fetch";
import { enablePluginInConfig } from "openclaw/plugin-sdk/provider-web-fetch";
import { runTinyFishFetch } from "./tinyfish-client.js";
import { TINYFISH_WEB_FETCH_PROVIDER_SHARED } from "./tinyfish-fetch-provider-shared.js";

export function createTinyFishWebFetchProvider(): WebFetchProviderPlugin {
  return {
    ...TINYFISH_WEB_FETCH_PROVIDER_SHARED,
    applySelectionConfig: (config) => enablePluginInConfig(config, "tinyfish").config,
    createTool: ({ config }) => ({
      description: "Fetch a page using TinyFish.",
      parameters: {},
      execute: async (args) => {
        const url = typeof args.url === "string" ? args.url : "";
        const extractMode = args.extractMode === "text" ? "text" : "markdown";
        const maxChars =
          typeof args.maxChars === "number" && Number.isFinite(args.maxChars)
            ? Math.floor(args.maxChars)
            : undefined;
        return await runTinyFishFetch({
          cfg: config,
          url,
          extractMode,
          maxChars,
        });
      },
    }),
  };
}
