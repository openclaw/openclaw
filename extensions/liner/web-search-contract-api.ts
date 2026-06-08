import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createLinerWebSearchProviderBase } from "./src/liner-web-search-provider.shared.js";

export function createLinerWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createLinerWebSearchProviderBase(),
    createTool: () => null,
  };
}
