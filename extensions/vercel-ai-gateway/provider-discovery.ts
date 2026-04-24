import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildStaticVercelAiGatewayProvider } from "./provider-catalog.js";

export const vercelAiGatewayProviderDiscovery: ProviderPlugin = {
  id: "vercel-ai-gateway",
  label: "Vercel AI Gateway",
  docsPath: "/providers/models",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildStaticVercelAiGatewayProvider(),
    }),
  },
};

export default vercelAiGatewayProviderDiscovery;
