import type { ProviderAppGuidedSetupContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildApiKeyCredential,
  ensureApiKeyFromEnvOrPrompt,
  normalizeOptionalSecretInput,
  type OpenClawConfig,
  type SecretInput,
  type SecretInputMode,
} from "openclaw/plugin-sdk/provider-auth";
import {
  buildOpenAICompatibleLiveModels,
  LiveModelCatalogHttpError,
  runLiveProviderCatalog,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  selectPreferredLocalModelId,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  configureOpenAICompatibleSelfHostedProviderNonInteractive,
  discoverOpenAICompatibleLocalModels,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import { resolveOmlxHeaders, resolveOmlxSecret, withoutOmlxAuthentication } from "./connection.js";
import {
  OMLX_API_KEY_ENV_VAR,
  OMLX_DEFAULT_BASE_URL,
  OMLX_LOCAL_API_KEY,
  OMLX_PROVIDER_ID,
} from "./defaults.js";
type Listing = NonNullable<Awaited<ReturnType<typeof listOmlxModels>>>;

function automaticModels(listing: Listing) {
  return listing.provider.models.filter((model) =>
    listing.rows.some(
      (row) =>
        row.model.id === model.id &&
        typeof row.model.max_model_len === "number" &&
        Number.isSafeInteger(row.model.max_model_len) &&
        row.model.max_model_len >= 16_384,
    ),
  );
}

function headerPatch(
  previous: ModelProviderConfig["headers"],
  next: ModelProviderConfig["headers"],
): Partial<NonNullable<ModelProviderConfig["headers"]>> | undefined {
  return previous
    ? { ...Object.fromEntries(Object.keys(previous).map((name) => [name, undefined])), ...next }
    : next;
}

function setupResult(
  listing: Listing,
  modelId: string,
  config: OpenClawConfig,
): ProviderAuthResult {
  const { provider } = listing;
  const configured = config.models?.providers?.omlx;
  const previous =
    configured?.baseUrl.trim().replace(/\/+$/, "") === provider.baseUrl ? configured : undefined;
  return {
    profiles: [],
    defaultModel: `${OMLX_PROVIDER_ID}/${modelId}`,
    configPatch: {
      models: {
        providers: {
          [OMLX_PROVIDER_ID]: {
            ...provider,
            // Auth patches deep-merge; explicit undefined removes prior endpoint credentials.
            auth: provider.auth,
            authHeader: provider.authHeader,
            headers: headerPatch(previous?.headers, provider.headers),
            request: provider.request
              ? {
                  ...provider.request,
                  auth: provider.request.auth,
                  headers: headerPatch(previous?.request?.headers, provider.request.headers),
                  proxy: provider.request.proxy,
                  tls: provider.request.tls,
                }
              : undefined,
          },
        },
      },
    },
  };
}

export async function detectOmlxAvailability(ctx: ProviderAppGuidedSetupContext) {
  return (await listOmlxModels(ctx)) !== null;
}

export async function detectOmlx(ctx: ProviderAppGuidedSetupContext) {
  const listing = await listOmlxModels(ctx);
  const modelId = listing && selectPreferredLocalModelId(automaticModels(listing).map((m) => m.id));
  return modelId ? { modelRef: `${OMLX_PROVIDER_ID}/${modelId}`, detail: modelId } : null;
}

export async function prepareOmlx(
  ctx: ProviderAppGuidedSetupContext & { modelRef: string },
): Promise<ProviderAuthResult | null> {
  const listing = await listOmlxModels(ctx);
  const model =
    listing && automaticModels(listing).find((m) => `${OMLX_PROVIDER_ID}/${m.id}` === ctx.modelRef);
  return listing && model ? setupResult(listing, model.id, ctx.config) : null;
}

const unavailableMessage =
  "No oMLX chat models were found. Start oMLX, add a chat model, and check the base URL and API key before running setup again.";

export async function configureOmlxInteractive(
  ctx: ProviderAuthContext,
): Promise<ProviderAuthResult> {
  const baseUrl = await ctx.prompter.text({
    message: "oMLX base URL",
    // Prefill only a saved URL: a prefilled default makes typed input append to it.
    initialValue: ctx.config.models?.providers?.omlx?.baseUrl,
    placeholder: OMLX_DEFAULT_BASE_URL,
    validate: (value) => {
      if (!value.trim()) {
        return undefined;
      }
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) ? undefined : "Use an HTTP or HTTPS URL";
      } catch {
        return "Enter the oMLX OpenAI-compatible base URL, including /v1";
      }
    },
  });
  let credentialInput: SecretInput = "";
  let credentialMode: SecretInputMode | undefined;
  const apiKey = await ensureApiKeyFromEnvOrPrompt({
    config: ctx.config,
    env: ctx.env,
    workspaceDir: ctx.workspaceDir,
    provider: OMLX_PROVIDER_ID,
    envLabel: OMLX_API_KEY_ENV_VAR,
    promptMessage: "oMLX API key (leave blank if authentication is disabled)",
    normalize: (value) => value.trim(),
    validate: () => undefined,
    prompter: ctx.prompter,
    secretInputMode:
      ctx.secretInputMode ?? (ctx.allowSecretRefPrompt === false ? "plaintext" : undefined),
    setCredential: async (value, mode) => {
      credentialInput = value;
      credentialMode = mode;
    },
  });
  const listing = await listOmlxModels({
    ...ctx,
    env: ctx.env ?? process.env,
    baseUrl: baseUrl.trim() || undefined,
    apiKey,
    replaceAuth: true,
  });
  if (!listing?.provider.models.length) {
    throw new Error(unavailableMessage);
  }
  const modelId = await ctx.prompter.select({
    message: "oMLX chat model",
    initialValue: selectPreferredLocalModelId(listing.provider.models.map((m) => m.id)),
    options: listing.provider.models.map((model) => ({ value: model.id, label: model.name })),
  });
  ctx.signal?.throwIfAborted();
  const credential = apiKey
    ? buildApiKeyCredential(OMLX_PROVIDER_ID, credentialInput, undefined, {
        secretInputMode: credentialMode,
      })
    : undefined;
  listing.provider.apiKey = credential?.keyRef ?? (apiKey ? "omlx:default" : OMLX_LOCAL_API_KEY);
  listing.provider.auth = credential?.keyRef ? "api-key" : listing.provider.auth;
  const result = setupResult(listing, modelId, ctx.config);
  if (credential) {
    result.profiles = [
      {
        profileId: "omlx:default",
        credential,
      },
    ];
  }
  return result;
}

type NonInteractiveContext = Omit<ProviderAuthMethodNonInteractiveContext, "toApiKeyCredential">;

async function prepareNonInteractive(ctx: NonInteractiveContext) {
  const modelId = normalizeOptionalSecretInput(ctx.opts.customModelId);
  const baseUrl = normalizeOptionalSecretInput(ctx.opts.customBaseUrl);
  const apiKey = normalizeOptionalSecretInput(ctx.opts.customApiKey);
  const replaceAuth = ctx.opts.customApiKey !== undefined;
  const configured = ctx.config.models?.providers?.omlx;
  const sameEndpoint =
    !baseUrl ||
    baseUrl.replace(/\/+$/, "") ===
      (configured?.baseUrl ?? OMLX_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const auth = configured?.request?.auth;
  const hasSavedAuth =
    sameEndpoint &&
    (configured?.apiKey !== undefined ||
      (auth !== undefined && auth.mode !== "provider-default") ||
      [configured?.headers, configured?.request?.headers].some((headers) =>
        Object.entries(headers ?? {}).some(
          ([name, value]) =>
            name.trim().toLowerCase() === "authorization" &&
            Boolean(typeof value === "string" ? value.trim() : value),
        ),
      ));
  if (!modelId) {
    ctx.runtime.error(
      "oMLX setup requires --custom-model-id. List model IDs at the server's /v1/models endpoint.",
    );
    return null;
  }
  const resolved =
    (!replaceAuth && hasSavedAuth) || (replaceAuth && !apiKey)
      ? null
      : await ctx.resolveApiKey({
          provider: OMLX_PROVIDER_ID,
          flagValue: apiKey,
          flagName: "--custom-api-key",
          envVar: OMLX_API_KEY_ENV_VAR,
          allowProfile: sameEndpoint,
          required: false,
        });
  const listing = await listOmlxModels({
    config: ctx.config,
    env: process.env,
    agentDir: ctx.agentDir,
    baseUrl,
    apiKey: resolved?.key ?? (replaceAuth ? "" : undefined),
    replaceAuth,
  });
  if (!listing?.provider.models.some((model) => model.id === modelId)) {
    ctx.runtime.error(`${unavailableMessage} Requested model: ${modelId}.`);
    return null;
  }
  return { listing, modelId, resolved };
}

export async function validateOmlxNonInteractive(ctx: NonInteractiveContext): Promise<boolean> {
  return (await prepareNonInteractive(ctx)) !== null;
}

export async function configureOmlxNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<OpenClawConfig | null> {
  const prepared = await prepareNonInteractive(ctx);
  if (!prepared) {
    ctx.runtime.exit(1);
    return null;
  }
  const { listing, modelId, resolved } = prepared;
  let credential:
    | ReturnType<ProviderAuthMethodNonInteractiveContext["toApiKeyCredential"]>
    | undefined;
  const config = await configureOpenAICompatibleSelfHostedProviderNonInteractive({
    ctx: {
      ...ctx,
      opts: { ...ctx.opts, customApiKey: resolved?.key ?? OMLX_LOCAL_API_KEY },
      resolveApiKey: async () => resolved ?? { key: OMLX_LOCAL_API_KEY, source: "flag" },
      toApiKeyCredential: (params) => {
        credential = ctx.toApiKeyCredential(params);
        return credential;
      },
    },
    providerId: OMLX_PROVIDER_ID,
    providerLabel: "oMLX",
    defaultBaseUrl: listing.provider.baseUrl,
    defaultApiKeyEnvVar: OMLX_API_KEY_ENV_VAR,
    modelPlaceholder: modelId,
  });
  if (!config?.models?.providers?.omlx) {
    return null;
  }
  config.models.providers.omlx = {
    ...listing.provider,
    auth: credential?.keyRef ? "api-key" : listing.provider.auth,
    apiKey:
      credential?.keyRef ??
      (resolved
        ? resolved.key === OMLX_LOCAL_API_KEY
          ? OMLX_LOCAL_API_KEY
          : resolved.source === "profile"
            ? listing.provider.apiKey
            : "omlx:default"
        : listing.provider.apiKey),
  };
  return config;
}

async function listOmlxModels(params: {
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
