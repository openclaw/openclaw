import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildStaticChutesProvider } from "./provider-catalog.js";

export const chutesProviderDiscovery: ProviderPlugin = {
  id: "chutes",
  label: "Chutes",
  docsPath: "/providers/models",
  auth: [],
  staticCatalog: {
    order: "profile",
    run: async () => ({
      provider: buildStaticChutesProvider(),
    }),
  },
};

export default chutesProviderDiscovery;
