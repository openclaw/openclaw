import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createApifyWebFetchProvider } from "./src/apify-fetch-provider.js";
import { createApifyWebSearchProvider } from "./src/apify-search-provider.js";

export default definePluginEntry({
  id: "apify",
  name: "Apify Plugin",
  description: "Apify RAG Web Browser web search and Website Content Crawler web fetch provider",
  register(api) {
    api.registerWebFetchProvider(createApifyWebFetchProvider());
    api.registerWebSearchProvider(createApifyWebSearchProvider());
  },
});
