import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildArceeProvider } from "./provider-catalog.js";

export const arceeProviderDiscovery: ProviderPlugin = {
  id: "arcee",
  label: "Arcee AI",
  docsPath: "/providers/models",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildArceeProvider(),
    }),
  },
};

export default arceeProviderDiscovery;
