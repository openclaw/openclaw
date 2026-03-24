import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createBochaWebSearchProvider } from "./src/bocha-web-search-provider.js";

export default definePluginEntry({
  id: "bocha",
  name: "Bocha Plugin",
  description: "Bundled Bocha plugin",
  register(api) {
    api.registerWebSearchProvider(createBochaWebSearchProvider());
  },
});
