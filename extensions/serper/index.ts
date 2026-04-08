import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSerperWebSearchProvider } from "./src/serper-web-search-provider.js";

export default definePluginEntry({
  id: "serper",
  name: "Serper (Google Search) Plugin",
  description: "Bundled Serper plugin",
  register(api) {
    api.registerWebSearchProvider(createSerperWebSearchProvider());
  },
});
