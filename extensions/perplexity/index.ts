import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildPerplexityDecisionProvider } from "./decision-provider.js";
import { createPerplexityWebSearchProvider } from "./src/perplexity-web-search-provider.js";

export default definePluginEntry({
  id: "perplexity",
  name: "Perplexity Plugin",
  description: "Bundled Perplexity plugin",
  register(api) {
    api.registerWebSearchProvider(createPerplexityWebSearchProvider());
    api.registerDecisionProvider(buildPerplexityDecisionProvider());
  },
});
