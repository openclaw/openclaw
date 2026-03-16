import {
  createPluginBackedWebSearchProvider,
  getScopedCredentialValue,
  setScopedCredentialValue,
} from "../../src/agents/tools/web-search-plugin-factory.js";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";

const perplexitySearchPlugin = {
  id: "web-search-perplexity",
  name: "Web Search Perplexity Provider",
  description: "Bundled Perplexity provider for the web_search tool",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerWebSearchProvider(
      createPluginBackedWebSearchProvider({
        id: "perplexity",
        label: "Perplexity Search",
        hint: "Structured results · domain/country/language/time filters",
        envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
        placeholder: "pplx-...",
        signupUrl: "https://www.perplexity.ai/settings/api",
        docsUrl: "https://docs.openclaw.ai/perplexity",
        autoDetectOrder: 50,
        getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "perplexity"),
        setCredentialValue: (searchConfigTarget, value) =>
          setScopedCredentialValue(searchConfigTarget, "perplexity", value),
      }),
    );
  },
};

export default perplexitySearchPlugin;
