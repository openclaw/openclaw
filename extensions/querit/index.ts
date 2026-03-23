import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createQueritWebSearchProvider } from "./src/querit-web-search-provider.js";

export default definePluginEntry({
  id: "querit",
  name: "Querit Plugin",
  description: "Bundled Querit plugin",
  register(api) {
    api.registerWebSearchProvider(createQueritWebSearchProvider());
  },
});
