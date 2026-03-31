import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createYepWebSearchProvider } from "./src/yep-web-search-provider.js";

export default definePluginEntry({
  id: "yep",
  name: "Yep Plugin",
  description: "Bundled Yep plugin",
  register(api) {
    api.registerWebSearchProvider(createYepWebSearchProvider());
  },
});
