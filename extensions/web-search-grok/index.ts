import {
  createPluginBackedWebSearchProvider,
  getScopedCredentialValue,
  setScopedCredentialValue,
} from "../../src/agents/tools/web-search-plugin-factory.js";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";

const grokSearchPlugin = {
  id: "web-search-grok",
  name: "Web Search Grok Provider",
  description: "Bundled Grok provider for the web_search tool",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerWebSearchProvider(
      createPluginBackedWebSearchProvider({
        id: "grok",
        label: "Grok (xAI)",
        hint: "xAI web-grounded responses",
        envVars: ["XAI_API_KEY"],
        placeholder: "xai-...",
        signupUrl: "https://console.x.ai/",
        docsUrl: "https://docs.openclaw.ai/tools/web",
        autoDetectOrder: 30,
        getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "grok"),
        setCredentialValue: (searchConfigTarget, value) =>
          setScopedCredentialValue(searchConfigTarget, "grok", value),
      }),
    );
  },
};

export default grokSearchPlugin;
