import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createBundledKimiSearchProvider } from "./provider.js";

const plugin = {
  id: "search-kimi",
  name: "Kimi Search",
  description: "Bundled Kimi web search provider for OpenClaw.",
  register(api: OpenClawPluginApi) {
    api.registerSearchProvider(createBundledKimiSearchProvider());
  },
};

export default plugin;
