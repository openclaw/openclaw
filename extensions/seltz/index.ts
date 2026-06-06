import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSeltzWebSearchProvider } from "./src/seltz-web-search-provider.js";

export default definePluginEntry({
  id: "seltz",
  name: "Seltz Plugin",
  description: "Bundled Seltz web search plugin",
  register(api) {
    api.registerWebSearchProvider(createSeltzWebSearchProvider());
  },
});
