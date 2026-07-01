// Qa Lab API module exposes the deterministic QA web_search contract.
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createQaLabWebSearchProvider as createQaLabRuntimeWebSearchProvider } from "./src/qa-web-search-provider.js";

export function createQaLabWebSearchProvider(): WebSearchProviderPlugin {
  const { createTool: _createTool, ...provider } = createQaLabRuntimeWebSearchProvider();
  void _createTool;
  return {
    ...provider,
    createTool: () => null,
  };
}
