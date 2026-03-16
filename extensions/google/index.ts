import {
  createPluginBackedWebSearchProvider,
  getScopedCredentialValue,
  setScopedCredentialValue,
} from "../../src/agents/tools/web-search-plugin-factory.js";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";

const googlePlugin = {
  id: "google",
  name: "Google Plugin",
  description: "Bundled Google plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerWebSearchProvider(
      createPluginBackedWebSearchProvider({
        id: "gemini",
        label: "Gemini (Google Search)",
        hint: "Google Search grounding · AI-synthesized",
        envVars: ["GEMINI_API_KEY"],
        placeholder: "AIza...",
        signupUrl: "https://aistudio.google.com/apikey",
        docsUrl: "https://docs.openclaw.ai/tools/web",
        autoDetectOrder: 20,
        getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "gemini"),
        setCredentialValue: (searchConfigTarget, value) =>
          setScopedCredentialValue(searchConfigTarget, "gemini", value),
      }),
    );
  },
};

export default googlePlugin;
