import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildKilocodeProvider } from "./provider-catalog.js";

export const kilocodeProviderDiscovery: ProviderPlugin = {
  id: "kilocode",
  label: "Kilo Code",
  docsPath: "/providers/models",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildKilocodeProvider(),
    }),
  },
};

export default kilocodeProviderDiscovery;
