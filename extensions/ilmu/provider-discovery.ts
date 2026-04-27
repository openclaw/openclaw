import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildIlmuProvider } from "./provider-catalog.js";

export const ilmuProviderDiscovery: ProviderPlugin = {
  id: "ilmu",
  label: "ILMU",
  docsPath: "/providers/ilmu",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildIlmuProvider(),
    }),
  },
};

export default ilmuProviderDiscovery;
