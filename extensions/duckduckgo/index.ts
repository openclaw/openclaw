import { definePluginEntry } from "mullusi/plugin-sdk/plugin-entry";
import { createDuckDuckGoWebSearchProvider } from "./src/ddg-search-provider.js";

export default definePluginEntry({
  id: "duckduckgo",
  name: "DuckDuckGo Plugin",
  description: "Bundled DuckDuckGo web search plugin",
  register(api) {
    api.registerWebSearchProvider(createDuckDuckGoWebSearchProvider());
  },
});
