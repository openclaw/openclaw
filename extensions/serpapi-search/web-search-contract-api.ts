import { type WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createSerpApiWebSearchProviderBase } from "./src/serpapi-search-provider.shared.js";

export function createSerpApiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createSerpApiWebSearchProviderBase(),
    createTool: () => null,
  };
}
