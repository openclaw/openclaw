// TokenLab provider module implements model/runtime integration.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildTokenLabProvider } from "./provider-catalog.js";

const tokenLabProviderDiscovery: ProviderPlugin = {
  id: "tokenlab",
  label: "TokenLab",
  docsPath: "/providers/tokenlab",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildTokenLabProvider(),
    }),
  },
};

export default tokenLabProviderDiscovery;
