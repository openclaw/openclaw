import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createComposioWebSearchProvider } from "./src/composio-search-provider.js";

export function createComposioWebSearchContractProvider(): WebSearchProviderPlugin {
  return createComposioWebSearchProvider();
}
