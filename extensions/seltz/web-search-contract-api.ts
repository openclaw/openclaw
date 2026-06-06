import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createSeltzWebSearchProviderBase } from "./src/seltz-web-search-provider.shared.js";

export function createSeltzWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createSeltzWebSearchProviderBase(),
    createTool: () => null,
  };
}
