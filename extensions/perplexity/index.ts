import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  createPluginBackedWebSearchProvider,
  getScopedCredentialValue,
  setScopedCredentialValue,
} from "openclaw/plugin-sdk/provider-web-search";

const perplexityPlugin = {
  id: "perplexity",
  name: "Perplexity Plugin",
  description: "Bundled Perplexity plugin",
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

export default perplexityPlugin;
