import {
  buildSingleProviderApiKeyCatalog,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildDeepInfraProvider, buildStaticDeepInfraProvider } from "./provider-catalog.js";

const PROVIDER_ID = "deepinfra";

const deepinfraProviderDiscovery: ProviderPlugin = {
  id: PROVIDER_ID,
  label: "DeepInfra",
  docsPath: "/providers/deepinfra",
  auth: [],
  catalog: {
    order: "simple",
    run: (ctx: ProviderCatalogContext) =>
      // buildSingleProviderApiKeyCatalog has already verified the API key
      // resolves (env var OR auth-profile store), so pass hasApiKey=true
      // through to discovery — otherwise auth-profile-only setups would
      // silently fall back to the static catalog instead of the live one.
      buildSingleProviderApiKeyCatalog({
        ctx,
        providerId: PROVIDER_ID,
        buildProvider: () =>
          buildDeepInfraProvider({
            hasApiKey: true,
            env: ctx.env,
            agentDir: ctx.agentDir,
          }),
      }),
  },
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildStaticDeepInfraProvider(),
    }),
  },
};

export default deepinfraProviderDiscovery;
