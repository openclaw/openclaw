import {
  createPluginBackedWebSearchProvider,
  getTopLevelCredentialValue,
  setTopLevelCredentialValue,
} from "../../src/agents/tools/web-search-plugin-factory.js";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";

const braveSearchPlugin = {
  id: "web-search-brave",
  name: "Web Search Brave Provider",
  description: "Bundled Brave provider for the web_search tool",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerWebSearchProvider(
      createPluginBackedWebSearchProvider({
        id: "brave",
        label: "Brave Search",
        hint: "Structured results · country/language/time filters",
        envVars: ["BRAVE_API_KEY"],
        placeholder: "BSA...",
        signupUrl: "https://brave.com/search/api/",
        docsUrl: "https://docs.openclaw.ai/brave-search",
        autoDetectOrder: 10,
        getCredentialValue: getTopLevelCredentialValue,
        setCredentialValue: setTopLevelCredentialValue,
      }),
    );
  },
};

export default braveSearchPlugin;
