import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildLlamaCppProviderConfig } from "./src/defaults.js";
import {
  hasLlamaServerAuthorizationHeader,
  shouldUseLlamaServerSyntheticAuth,
} from "./src/external-server/auth-policy.js";
import {
  LLAMA_APP_SERVER,
  LLAMA_CPP_SERVER,
  type LlamaServerIdentity,
} from "./src/external-server/defaults.js";
import { normalizeLlamaServerProviderConfig } from "./src/external-server/endpoint.js";

function createLlamaServerDiscovery(server: LlamaServerIdentity) {
  const managed = server.id === LLAMA_CPP_SERVER.id;
  return {
    id: server.id,
    label: server.label,
    docsPath: "/plugins/llama-cpp",
    envVars: [server.apiKeyEnvVar],
    auth: [],
    catalog: {
      order: "late",
      run: async (ctx) => {
        if (ctx.providerIds && !ctx.providerIds.includes(server.id)) {
          return null;
        }
        const configured = ctx.config.models?.providers?.[server.id];
        if (managed && configured?.localService) {
          return {
            provider: buildLlamaCppProviderConfig({
              existing: configured,
              modelInventory: configured.models,
            }),
          };
        }
        const { discoverLlamaServerProvider } = await import("./src/external-server/provider.js");
        return await discoverLlamaServerProvider(ctx, server);
      },
    },
    staticCatalog: {
      order: "late",
      run: async () => ({
        provider: managed
          ? buildLlamaCppProviderConfig()
          : normalizeLlamaServerProviderConfig(
              { baseUrl: server.defaultOrigin, models: [] },
              server,
            ),
      }),
    },
    resolveSyntheticAuth: ({ providerConfig }) =>
      (managed && providerConfig?.localService) || shouldUseLlamaServerSyntheticAuth(providerConfig)
        ? {
            apiKey: server.authMarker,
            source:
              managed && providerConfig?.localService
                ? "managed local llama.cpp server"
                : hasLlamaServerAuthorizationHeader(providerConfig?.headers)
                  ? `models.providers.${server.id}.headers.Authorization`
                  : `models.providers.${server.id} (synthetic local key)`,
            mode: "api-key",
          }
        : undefined,
    shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
      resolvedApiKey?.trim() === LLAMA_CPP_SERVER.authMarker ||
      resolvedApiKey?.trim() === LLAMA_APP_SERVER.authMarker ||
      resolvedApiKey?.trim() === CUSTOM_LOCAL_AUTH_MARKER,
    normalizeConfig: ({ providerConfig }) =>
      managed && providerConfig.localService
        ? providerConfig
        : normalizeLlamaServerProviderConfig(providerConfig, server),
  } satisfies ProviderPlugin;
}

export const llamaCppProviderDiscovery = createLlamaServerDiscovery(LLAMA_CPP_SERVER);
export const llamaAppProviderDiscovery = createLlamaServerDiscovery(LLAMA_APP_SERVER);
export default [llamaCppProviderDiscovery, llamaAppProviderDiscovery];
