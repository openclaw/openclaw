import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  createPluginBackedWebSearchProvider,
  getTopLevelCredentialValue,
  setTopLevelCredentialValue,
} from "openclaw/plugin-sdk/provider-web-search";

const bravePlugin = {
  id: "brave",
  name: "Brave Plugin",
  description: "Bundled Brave plugin",
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

export default bravePlugin;
