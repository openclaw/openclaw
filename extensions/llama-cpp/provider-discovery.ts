import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  LLAMA_CPP_PROVIDER_ID,
  LLAMA_CPP_PROVIDER_LABEL,
  LLAMA_CPP_LOCAL_AUTH_MARKER,
  buildLlamaCppProviderConfig,
} from "./src/defaults.js";
import {
  hasLlamaServerAuthorizationHeader,
  shouldUseLlamaServerSyntheticAuth,
} from "./src/external-server/auth-policy.js";
import { LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR } from "./src/external-server/defaults.js";
import { normalizeLlamaServerProviderConfig } from "./src/external-server/endpoint.js";

export default {
  id: LLAMA_CPP_PROVIDER_ID,
  label: LLAMA_CPP_PROVIDER_LABEL,
  docsPath: "/plugins/llama-cpp",
  envVars: [LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR],
  auth: [],
  catalog: {
    order: "late",
    run: async (ctx) => {
      const configured = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
      if (configured?.localService) {
        return {
          provider: buildLlamaCppProviderConfig({
            existing: configured,
            modelInventory: configured.models,
          }),
        };
      }
      const { discoverLlamaServerProvider } = await import("./src/external-server/provider.js");
      return await discoverLlamaServerProvider(ctx);
    },
  },
  staticCatalog: {
    order: "late",
    run: async () => ({ provider: buildLlamaCppProviderConfig() }),
  },
  resolveSyntheticAuth: ({ providerConfig }) =>
    providerConfig?.localService || shouldUseLlamaServerSyntheticAuth(providerConfig)
      ? {
          apiKey: LLAMA_CPP_LOCAL_AUTH_MARKER,
          source: providerConfig?.localService
            ? "managed local llama.cpp server"
            : hasLlamaServerAuthorizationHeader(providerConfig?.headers)
              ? "models.providers.llama-cpp.headers.Authorization"
              : "models.providers.llama-cpp (synthetic local key)",
          mode: "api-key",
        }
      : undefined,
  shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
    resolvedApiKey?.trim() === LLAMA_CPP_LOCAL_AUTH_MARKER ||
    resolvedApiKey?.trim() === CUSTOM_LOCAL_AUTH_MARKER,
  normalizeConfig: ({ providerConfig }) =>
    providerConfig.localService
      ? providerConfig
      : normalizeLlamaServerProviderConfig(providerConfig),
} satisfies ProviderPlugin;
