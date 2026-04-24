import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildArceeOpenRouterProvider, buildArceeProvider } from "./provider-catalog.js";

export const arceeProviderDiscovery: ProviderPlugin[] = [
  {
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
  },
  {
    id: "arcee-openrouter",
    label: "Arcee AI via OpenRouter",
    docsPath: "/providers/models",
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => ({
        provider: buildArceeOpenRouterProvider(),
      }),
    },
  },
];

export default arceeProviderDiscovery;
