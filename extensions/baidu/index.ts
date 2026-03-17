import {
  createPluginBackedWebSearchProvider,
  getScopedCredentialValue,
  setScopedCredentialValue,
} from "../../src/agents/tools/web-search-plugin-factory.js";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";

const baiduPlugin = {
  id: "baidu",
  name: "Baidu Plugin",
  description: "Bundled Baidu plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerWebSearchProvider(
      createPluginBackedWebSearchProvider({
        id: "baidu",
        label: "Baidu Search",
        hint: "Structured results",
        envVars: ["BAIDU_SEARCH_API_KEY"],
        placeholder: "bce-...",
        signupUrl: "https://console.bce.baidu.com/ai-search/qianfan/ais/console/apiKey",
        docsUrl: "https://docs.openclaw.ai/tools/web",
        autoDetectOrder: 5,
        getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "baidu"),
        setCredentialValue: (searchConfigTarget, value) =>
          setScopedCredentialValue(searchConfigTarget, "baidu", value),
      }),
    );
  },
};

export default baiduPlugin;
