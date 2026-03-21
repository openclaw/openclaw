import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSearxngWebSearchProvider } from "./src/searxng-web-search-provider.js";

export default definePluginEntry({
  id: "searxng",
  name: "SearXNG Plugin",
  description: "Bundled SearXNG self-hosted search plugin",
  register(api) {
    api.registerWebSearchProvider(createSearxngWebSearchProvider());
  },
});
