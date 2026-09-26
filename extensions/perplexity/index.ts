// Perplexity plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPerplexityResearchTool } from "./src/perplexity-research-tool.js";
import { createPerplexityWebSearchProvider } from "./src/perplexity-web-search-provider.js";

export default definePluginEntry({
  id: "perplexity",
  name: "Perplexity Plugin",
  description: "Bundled Perplexity search and research plugin",
  register(api) {
    api.registerWebSearchProvider(createPerplexityWebSearchProvider());
    api.registerTool((ctx) => createPerplexityResearchTool(api, ctx), {
      name: "perplexity_research",
      optional: true,
    });
  },
});
