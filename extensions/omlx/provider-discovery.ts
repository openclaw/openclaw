import type { ModelRequestHeaders } from "openclaw/plugin-sdk/llm";
import type {
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { OMLX_API_KEY_ENV_VAR, OMLX_LOCAL_API_KEY, OMLX_PROVIDER_ID } from "./defaults.js";

function hasOmlxAuthorization(
  providerConfig: ModelProviderConfig | undefined,
  modelHeaders: ModelRequestHeaders | undefined,
  request:
    | ModelProviderConfig["request"]
    | ReturnType<
        typeof import("openclaw/plugin-sdk/agent-harness-runtime").getModelProviderRequestTransport
      >,
): boolean {
  const auth = request?.auth;
  if (auth?.mode === "authorization-bearer") {
    return true;
  }
  if (auth?.mode === "header") {
    // Request auth replaces earlier Authorization headers, including with a custom header.
    return auth.headerName.trim().toLowerCase() === "authorization";
  }
  return [providerConfig?.headers, request?.headers, modelHeaders].some((headers) =>
    Object.entries(headers ?? {}).some(
      ([name, value]) =>
        name.trim().toLowerCase() === "authorization" &&
        Boolean(typeof value === "string" ? value.trim() : value),
    ),
  );
}

export default {
  id: OMLX_PROVIDER_ID,
  label: "oMLX",
  docsPath: "/providers/omlx",
  envVars: [OMLX_API_KEY_ENV_VAR],
  auth: [],
  catalog: {
    order: "late",
    run: async (ctx) => {
      const { discoverOmlxProvider } = await import("./setup.js");
      return discoverOmlxProvider(ctx);
    },
  },
  resolveSyntheticAuth: ({ providerConfig }) => {
    if (providerConfig?.apiKey && providerConfig.apiKey !== OMLX_LOCAL_API_KEY) {
      return undefined;
    }
    return {
      apiKey: OMLX_LOCAL_API_KEY,
      source: "oMLX local server",
      mode: "api-key",
    };
  },
  prepareRuntimeAuth: async ({ config, provider, model, apiKey }) => {
    const [
      { CUSTOM_LOCAL_AUTH_MARKER, findNormalizedProviderValue },
      { getModelProviderRequestTransport },
    ] = await Promise.all([
      import("openclaw/plugin-sdk/provider-auth"),
      import("openclaw/plugin-sdk/agent-harness-runtime"),
    ]);
    const providerConfig = findNormalizedProviderValue(config?.models?.providers, provider);
    const request = getModelProviderRequestTransport(model) ?? providerConfig?.request;
    if (
      providerConfig?.apiKey &&
      providerConfig.apiKey !== OMLX_LOCAL_API_KEY &&
      request?.auth?.mode !== "header"
    ) {
      return undefined;
    }
    if (hasOmlxAuthorization(providerConfig, model.headers, request)) {
      // The generic marker clears Authorization downstream, including explicit headers.
      return { apiKey: OMLX_LOCAL_API_KEY };
    }
    if (
      providerConfig?.apiKey === OMLX_LOCAL_API_KEY ||
      apiKey === OMLX_LOCAL_API_KEY ||
      apiKey === CUSTOM_LOCAL_AUTH_MARKER ||
      request?.auth?.mode === "header"
    ) {
      // Explicit keyless or header auth must not inherit a stored bearer credential.
      return { apiKey: CUSTOM_LOCAL_AUTH_MARKER };
    }
    return undefined;
  },
} satisfies ProviderPlugin;
