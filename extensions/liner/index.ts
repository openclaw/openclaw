import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createLinerWebSearchProvider } from "./src/liner-web-search-provider.js";

export default definePluginEntry({
  id: "liner",
  name: "Liner Plugin",
  description: "Bundled Liner web search plugin",
  register(api) {
    // Liner Search v1 REST API (requires LINER_API_KEY). Issue a key at
    // https://platform.liner.com — new accounts get free credits to start.
    api.registerWebSearchProvider(createLinerWebSearchProvider());
  },
});
