import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createExaWebSearchProvider } from "./src/exa-search-provider.js";

export default definePluginEntry({
  id: "exa",
  name: "Exa Plugin",
  description: "Bundled Exa web search plugin",
  register(api) {
    api.registerWebSearchProvider(createExaWebSearchProvider());
  },
});
