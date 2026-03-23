import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createQverisWebSearchProvider } from "./src/qveris-web-search-provider.js";

export default definePluginEntry({
  id: "qveris",
  name: "QVeris Plugin",
  description: "Bundled QVeris web search plugin",
  register(api) {
    api.registerWebSearchProvider(createQverisWebSearchProvider());
  },
});
