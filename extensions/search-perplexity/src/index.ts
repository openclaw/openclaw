import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createBundledPerplexitySearchProvider } from "./provider.js";

const plugin = {
  id: "search-perplexity",
  name: "Perplexity Search",
  description: "Bundled Perplexity web search provider for OpenClaw.",
  register(api: OpenClawPluginApi) {
    api.registerSearchProvider(createBundledPerplexitySearchProvider());
  },
};

export default plugin;
