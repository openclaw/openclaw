import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createKeenableWebSearchProvider } from "./src/keenable-web-search-provider.js";

export default definePluginEntry({
  id: "keenable",
  name: "Keenable Plugin",
  description: "Bundled Keenable web search plugin",
  register(api) {
    api.registerWebSearchProvider(createKeenableWebSearchProvider());
  },
});
