import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createBundledGrokSearchProvider } from "./provider.js";

const plugin = {
  id: "search-grok",
  name: "Grok Search",
  description: "Bundled xAI Grok web search provider for OpenClaw.",
  register(api: OpenClawPluginApi) {
    api.registerSearchProvider(createBundledGrokSearchProvider());
  },
};

export default plugin;
