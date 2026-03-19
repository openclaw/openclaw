import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createTavilyWebSearchProvider } from "./src/tavily-web-search-provider.js";

export default definePluginEntry({
  id: "tavily",
  name: "Tavily Plugin",
  description: "Bundled Tavily plugin",
  register(api) {
    api.registerWebSearchProvider(createTavilyWebSearchProvider());
  },
});
