import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createBundledBraveSearchProvider } from "./provider.js";

const plugin = {
  id: "search-brave",
  name: "Brave Search",
  description: "Bundled Brave web search provider for OpenClaw.",
  register(api: OpenClawPluginApi) {
    api.registerSearchProvider(createBundledBraveSearchProvider());
  },
};

export default plugin;
