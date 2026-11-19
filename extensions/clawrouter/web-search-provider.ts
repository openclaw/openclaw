import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createWebSearchProviderContractFields,
  WEB_SEARCH_QUERY_COUNT_PROPERTIES,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

const loadRuntime = createLazyRuntimeModule(() => import("./web-search-runtime.js"));

export function createClawRouterWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "clawrouter",
    label: "ClawRouter",
    hint: "Search through a granted ClawRouter endpoint",
    authProviderId: "clawrouter",
    envVars: ["CLAWROUTER_API_KEY"],
    placeholder: "ClawRouter proxy key",
    signupUrl: "https://clawrouter.openclaw.ai",
    configPath: null,
    credentialPath: "models.providers.clawrouter.apiKey",
    ...createWebSearchProviderContractFields({
      credentialPath: "models.providers.clawrouter.apiKey",
      inactiveSecretPaths: [],
      searchCredential: { type: "none" },
      selectionPluginId: "clawrouter",
    }),
    getConfiguredCredentialValue: (cfg) => cfg?.models?.providers?.clawrouter?.apiKey,
    createTool: (ctx) => ({
      description: "Search the web through an eligible ClawRouter catalog endpoint.",
      parameters: {
        type: "object",
        properties: WEB_SEARCH_QUERY_COUNT_PROPERTIES,
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args, execution) => {
        execution?.signal?.throwIfAborted();
        const { searchClawRouter } = await loadRuntime();
        return searchClawRouter(ctx, args, execution);
      },
    }),
  };
}
