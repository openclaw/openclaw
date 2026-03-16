import { normalizeProviderId } from "../../src/agents/model-selection.js";
import {
  createPluginBackedWebSearchProvider,
  getScopedCredentialValue,
  setScopedCredentialValue,
} from "../../src/agents/tools/web-search-plugin-factory.js";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";

const XAI_MODERN_MODEL_PREFIXES = ["grok-4"] as const;

function matchesModernXaiModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return XAI_MODERN_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

const xaiPlugin = {
  id: "xai",
  name: "xAI Plugin",
  description: "Bundled xAI plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: "xai",
      label: "xAI",
      docsPath: "/providers/models",
      envVars: ["XAI_API_KEY"],
      auth: [],
      isModernModelRef: ({ provider, modelId }) =>
        normalizeProviderId(provider) === "xai" ? matchesModernXaiModel(modelId) : undefined,
    });
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

export default xaiPlugin;
