// Pioneer provider discovery exposes live and static catalog metadata to model-list paths.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildPioneerCatalogResult, buildPioneerProvider } from "./provider-catalog.js";

const pioneerProviderDiscovery: ProviderPlugin = {
  id: "pioneer",
  label: "Pioneer",
  docsPath: "/providers/pioneer",
  envVars: ["PIONEER_API_KEY"],
  auth: [],
  catalog: {
    order: "simple",
    run: buildPioneerCatalogResult,
  },
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildPioneerProvider(),
    }),
  },
};

export default pioneerProviderDiscovery;
