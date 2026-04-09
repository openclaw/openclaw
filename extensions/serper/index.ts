import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSerperWebSearchProviderPlugin } from "./src/serper-web-search-provider.js";

export default definePluginEntry({
  id: "serper",
  name: "Serper Plugin",
  description: "Bundled Serper (Google Search) plugin",
  register(api) {
    api.registerWebSearchProvider(createSerperWebSearchProviderPlugin());
  },
});
