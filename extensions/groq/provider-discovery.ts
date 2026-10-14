import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-model-metadata";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "groq";

const groqProviderDiscovery: ProviderPlugin = {
  id: PROVIDER_ID,
  label: "Groq",
  docsPath: "/providers/groq",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildManifestModelProviderConfig({
        providerId: PROVIDER_ID,
        catalog: manifest.modelCatalog.providers.groq,
      }),
    }),
  },
};

export default groqProviderDiscovery;
