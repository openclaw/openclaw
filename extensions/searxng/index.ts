import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSearXNGWebSearchProvider } from "./src/searxng-provider.js";

export default definePluginEntry({
  id: "searxng",
  name: "SearXNG Plugin",
  description: "Bundled SearXNG web search plugin",
  register(api) {
    api.registerWebSearchProvider(createSearXNGWebSearchProvider());
  },
});
