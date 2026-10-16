import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import {
  buildOpenAICompatibleLiveModels,
  LiveModelCatalogHttpError,
  runLiveProviderCatalog,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  discoverOpenAICompatibleLocalModels,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import { resolveOmlxHeaders, resolveOmlxSecret, withoutOmlxAuthentication } from "./connection.js";
import {
  OMLX_API_KEY_ENV_VAR,
  OMLX_DEFAULT_BASE_URL,
  OMLX_LOCAL_API_KEY,
  OMLX_PROVIDER_ID,
} from "./defaults.js";

export async function listOmlxModels(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  baseUrl?: string;
  apiKey?: string;
  replaceAuth?: boolean;
  agentDir?: string;
  signal?: AbortSignal;
  strict?: boolean;
}) {
  params.signal?.throwIfAborted();
  const configured = params.config.models?.providers?.[OMLX_PROVIDER_ID];
  const baseUrl = (params.baseUrl ?? configured?.baseUrl ?? OMLX_DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  // Saved endpoint credentials must never follow a URL entered during setup.
  let existing =
    (configured?.baseUrl ?? OMLX_DEFAULT_BASE_URL).trim().replace(/\/+$/, "") === baseUrl
      ? configured
      : undefined;
  if (params.replaceAuth && existing) {
    existing = withoutOmlxAuthentication(existing);
  }
  const request =
    existing?.request ??
    (configured?.request?.allowPrivateNetwork !== undefined
      ? { allowPrivateNetwork: configured.request.allowPrivateNetwork }
      : undefined);
  try {
    const { headers, hasHeaderAuth } = await resolveOmlxHeaders(params, existing);
    const configuredKey =
      params.apiKey === undefined && !hasHeaderAuth
        ? await resolveOmlxSecret(params, existing?.apiKey, "models.providers.omlx.apiKey")
        : undefined;
    const profileKey =
      configuredKey &&
      configuredKey !== OMLX_LOCAL_API_KEY &&
      typeof existing?.apiKey === "string" &&
      (configuredKey !== OMLX_API_KEY_ENV_VAR || !params.env[OMLX_API_KEY_ENV_VAR])
        ? (
            await (
              await import("openclaw/plugin-sdk/provider-auth-runtime")
            ).resolveApiKeyForProvider({
              provider: OMLX_PROVIDER_ID,
              // Catalog probes must keep the configured key ahead of ambient credentials.
              cfg: {
                ...params.config,
                models: {
                  ...params.config.models,
                  providers: {
                    ...params.config.models?.providers,
                    [OMLX_PROVIDER_ID]: {
                      ...existing,
                      baseUrl,
                      auth: "api-key",
                      models: existing?.models ?? [],
                    },
                  },
                },
              },
              agentDir: params.agentDir,
              allowAuthProfileFallback: configuredKey === OMLX_API_KEY_ENV_VAR,
            })
          ).apiKey
        : undefined;
    const apiKey =
      params.apiKey ??
      profileKey ??
      (configuredKey === OMLX_API_KEY_ENV_VAR ? params.env[OMLX_API_KEY_ENV_VAR] : configuredKey) ??
      params.env[OMLX_API_KEY_ENV_VAR];
    const result = await discoverOpenAICompatibleLocalModels({
      baseUrl,
      apiKey: hasHeaderAuth || apiKey === OMLX_LOCAL_API_KEY ? undefined : apiKey,
      headers,
      allowPrivateNetwork: request?.allowPrivateNetwork,
      label: "oMLX",
      discoverRuntimeContext: false,
      rawResult: true,
      signal: params.signal,
    });
    params.signal?.throwIfAborted();
    if (result.kind !== "success") {
      if (params.strict) {
        throw result.kind === "http-error"
          ? new LiveModelCatalogHttpError(OMLX_PROVIDER_ID, result.status)
          : new Error("oMLX model discovery unavailable. Check the server URL and API key.");
      }
      return null;
    }
    const provider: ModelProviderConfig = {
      ...existing,
      baseUrl,
      api: "openai-completions",
      apiKey: existing?.apiKey ?? (apiKey ? OMLX_API_KEY_ENV_VAR : OMLX_LOCAL_API_KEY),
      ...(request ? { request } : {}),
      models: existing?.models ?? [],
    };
    // oMLX's inference catalog has no model-type field. Use the shared chat
    // projection; embedding models remain explicitly selected by memory setup.
    provider.models = buildOpenAICompatibleLiveModels(
      result.rows.map(({ model }) => model),
      provider,
    );
    return { provider, rows: result.rows };
  } catch (error) {
    params.signal?.throwIfAborted();
    if (params.strict) {
      throw error;
    }
    return null;
  }
}

export async function discoverOmlxProvider(ctx: ProviderCatalogContext) {
  if (ctx.providerIds && !ctx.providerIds.includes(OMLX_PROVIDER_ID)) {
    return null;
  }
  if (!ctx.providerIds && !ctx.config.models?.providers?.omlx && !ctx.env[OMLX_API_KEY_ENV_VAR]) {
    return null;
  }
  const configuredKey = ctx.config.models?.providers?.omlx?.apiKey;
  const auth =
    configuredKey === undefined ? ctx.resolveProviderApiKey(OMLX_PROVIDER_ID) : undefined;
  const result = await runLiveProviderCatalog({
    providerId: OMLX_PROVIDER_ID,
    run: async () => {
      const listing = await listOmlxModels({ ...ctx, apiKey: auth?.discoveryApiKey, strict: true });
      if (!listing) {
        throw new Error("oMLX model discovery unavailable");
      }
      return {
        provider: {
          ...listing.provider,
          apiKey: configuredKey ?? auth?.apiKey ?? listing.provider.apiKey,
        },
        outcomes: [
          {
            provider: OMLX_PROVIDER_ID,
            status: "ready" as const,
            modelIdCatalog: {
              baseUrl: listing.provider.baseUrl,
              modelIds: listing.rows.flatMap(({ model }) =>
                typeof model.id === "string" ? [model.id] : [],
              ),
            },
          },
        ],
      };
    },
  });
  ctx.signal?.throwIfAborted();
  return result;
}
