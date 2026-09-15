// Staan plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createStaanWebSearchProvider } from "./src/staan-web-search-provider.js";

export default definePluginEntry({
  id: "staan",
  name: "Staan Plugin",
  description: "Bundled Staan web search plugin",
  register(api) {
    api.registerWebSearchProvider(createStaanWebSearchProvider());
  },
});
