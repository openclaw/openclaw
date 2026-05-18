import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createComposioWebSearchProvider } from "./src/composio-search-provider.js";

export default definePluginEntry({
  id: "composio",
  name: "Composio Plugin",
  description: "Bundled Composio web search plugin",
  register(api) {
    api.registerWebSearchProvider(createComposioWebSearchProvider());
  },
});
