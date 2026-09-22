// Deepinfra provider module implements model/runtime integration.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildStaticDeepInfraProvider } from "./provider-static-catalog.js";

const PROVIDER_ID = "deepinfra";

const deepinfraProviderDiscovery: ProviderPlugin = {
  id: PROVIDER_ID,
  label: "DeepInfra",
  docsPath: "/providers/deepinfra",
  auth: [],
  catalog: {
    order: "simple",
    // Static inventory stays independent of credential and network discovery.
    run: async (ctx) => {
      const { buildDeepInfraApiKeyCatalog } = await import("./provider-catalog.js");
      return await buildDeepInfraApiKeyCatalog(ctx);
    },
  },
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildStaticDeepInfraProvider(),
    }),
  },
};

export default deepinfraProviderDiscovery;
