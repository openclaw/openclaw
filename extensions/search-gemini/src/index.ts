import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createBundledGeminiSearchProvider } from "./provider.js";

const plugin = {
  id: "search-gemini",
  name: "Gemini Search",
  description: "Bundled Gemini web search provider for OpenClaw.",
  register(api: OpenClawPluginApi) {
    api.registerSearchProvider(createBundledGeminiSearchProvider());
  },
};

export default plugin;
