import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { LLAMA_PROVIDER_ID, LLAMA_PROVIDER_LABEL } from "./defaults.js";

export default {
  id: LLAMA_PROVIDER_ID,
  label: LLAMA_PROVIDER_LABEL,
  docsPath: "/providers/llama",
  envVars: [],
  auth: [],
  catalog: {
    order: "late",
    run: async (ctx) => (await import("./setup.js")).discoverLlamaProvider(ctx),
  },
  // The app's server runs without an API key; an authored key still wins.
  resolveSyntheticAuth: ({ providerConfig }) =>
    providerConfig && providerConfig.apiKey === undefined
      ? {
          apiKey: CUSTOM_LOCAL_AUTH_MARKER,
          source: "models.providers.llama (synthetic local key)",
          mode: "api-key",
        }
      : undefined,
} satisfies ProviderPlugin;
