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
  readLiveModelCatalogPositiveSafeIntegerField,
  runLiveProviderCatalog,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  selectPreferredLocalModelId,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { applyProviderConnectionConfig } from "openclaw/plugin-sdk/provider-onboard";
import {
  configureOpenAICompatibleSelfHostedProviderNonInteractive,
  discoverOpenAICompatibleLocalModels,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import {
  resolveRapidMlxHeaders,
  resolveRapidMlxSecret,
  withoutRapidMlxAuthentication,
} from "./connection.js";
import {
  RAPID_MLX_API_KEY_ENV_VAR,
  RAPID_MLX_DEFAULT_BASE_URL,
  RAPID_MLX_LOCAL_API_KEY,
  RAPID_MLX_PROVIDER_ID,
} from "./defaults.js";
type Listing = NonNullable<Awaited<ReturnType<typeof listRapidMlxModels>>>;

function automaticModels(listing: Listing) {
  return listing.provider.models.filter((model) =>
    listing.rows.some(
      (row) =>
        row.model.id === model.id &&
        typeof row.model.context_window === "number" &&
        Number.isSafeInteger(row.model.context_window) &&
        row.model.context_window >= 16_384,
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

function connectionProvider(listing: Listing, config: OpenClawConfig): ModelProviderConfig {
  const connection = applyProviderConnectionConfig(config, {
    providerId: RAPID_MLX_PROVIDER_ID,
    api: "openai-completions",
    baseUrl: listing.provider.baseUrl,
    // Inventory belongs to discovery even in replace mode; retain authored rows.
    catalogModels: [],
  });
  return {
    ...listing.provider,
    models: connection.models?.providers?.[RAPID_MLX_PROVIDER_ID]?.models ?? [],
  };
}

function setupResult(
  listing: Listing,
  modelId: string,
  config: OpenClawConfig,
): ProviderAuthResult {
  const provider = connectionProvider(listing, config);
  const configured = config.models?.providers?.["rapid-mlx"];
  const previous =
    configured?.baseUrl.trim().replace(/\/+$/, "") === provider.baseUrl ? configured : undefined;
  return {
    profiles: [],
    defaultModel: `${RAPID_MLX_PROVIDER_ID}/${modelId}`,
    configPatch: {
      models: {
        providers: {
          [RAPID_MLX_PROVIDER_ID]: {
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

export async function detectRapidMlxAvailability(ctx: ProviderAppGuidedSetupContext) {
  return (await listRapidMlxModels(ctx)) !== null;
}

export async function detectRapidMlx(ctx: ProviderAppGuidedSetupContext) {
  const listing = await listRapidMlxModels(ctx);
  const modelId = listing && selectPreferredLocalModelId(automaticModels(listing).map((m) => m.id));
  return modelId ? { modelRef: `${RAPID_MLX_PROVIDER_ID}/${modelId}`, detail: modelId } : null;
}

export async function prepareRapidMlx(
  ctx: ProviderAppGuidedSetupContext & { modelRef: string },
): Promise<ProviderAuthResult | null> {
  const listing = await listRapidMlxModels(ctx);
  const model =
    listing &&
    automaticModels(listing).find((m) => `${RAPID_MLX_PROVIDER_ID}/${m.id}` === ctx.modelRef);
  return listing && model ? setupResult(listing, model.id, ctx.config) : null;
}

const unavailableMessage =
  "No Rapid-MLX chat models were found. Start Rapid-MLX, add a chat model, and check the base URL and API key before running setup again.";

export async function configureRapidMlxInteractive(
  ctx: ProviderAuthContext,
): Promise<ProviderAuthResult> {
  const baseUrl = await ctx.prompter.text({
    message: "Rapid-MLX base URL",
    // Prefill only a saved URL: a prefilled default makes typed input append to it.
    initialValue: ctx.config.models?.providers?.["rapid-mlx"]?.baseUrl,
    placeholder: RAPID_MLX_DEFAULT_BASE_URL,
    validate: (value) => {
      if (!value.trim()) {
        return undefined;
      }
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) ? undefined : "Use an HTTP or HTTPS URL";
      } catch {
        return "Enter the Rapid-MLX OpenAI-compatible base URL, including /v1";
      }
    },
  });
  let credentialInput: SecretInput = "";
  let credentialMode: SecretInputMode | undefined;
  const apiKey = await ensureApiKeyFromEnvOrPrompt({
    config: ctx.config,
    env: ctx.env,
    workspaceDir: ctx.workspaceDir,
    provider: RAPID_MLX_PROVIDER_ID,
    envLabel: RAPID_MLX_API_KEY_ENV_VAR,
    promptMessage: "Rapid-MLX API key (leave blank if authentication is disabled)",
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
  const listing = await listRapidMlxModels({
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
    message: "Rapid-MLX chat model",
    initialValue: selectPreferredLocalModelId(listing.provider.models.map((m) => m.id)),
    options: listing.provider.models.map((model) => ({ value: model.id, label: model.name })),
  });
  ctx.signal?.throwIfAborted();
  const credential = apiKey
    ? buildApiKeyCredential(RAPID_MLX_PROVIDER_ID, credentialInput, undefined, {
        secretInputMode: credentialMode,
      })
    : undefined;
  listing.provider.apiKey =
    credential?.keyRef ?? (apiKey ? "rapid-mlx:default" : RAPID_MLX_LOCAL_API_KEY);
  listing.provider.auth = credential?.keyRef ? "api-key" : listing.provider.auth;
  const result = setupResult(listing, modelId, ctx.config);
  if (credential) {
    result.profiles = [
      {
        profileId: "rapid-mlx:default",
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
  const configured = ctx.config.models?.providers?.["rapid-mlx"];
  const sameEndpoint =
    !baseUrl ||
    baseUrl.replace(/\/+$/, "") ===
      (configured?.baseUrl ?? RAPID_MLX_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
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
      "Rapid-MLX setup requires --custom-model-id. List model IDs at the server's /v1/models endpoint.",
    );
    return null;
  }
  const resolved =
    (!replaceAuth && hasSavedAuth) || (replaceAuth && !apiKey)
      ? null
      : await ctx.resolveApiKey({
          provider: RAPID_MLX_PROVIDER_ID,
          flagValue: apiKey,
          flagName: "--custom-api-key",
          envVar: RAPID_MLX_API_KEY_ENV_VAR,
          allowProfile: sameEndpoint,
          required: false,
        });
  const listing = await listRapidMlxModels({
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

export async function validateRapidMlxNonInteractive(ctx: NonInteractiveContext): Promise<boolean> {
  return (await prepareNonInteractive(ctx)) !== null;
}

export async function configureRapidMlxNonInteractive(
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
      opts: { ...ctx.opts, customApiKey: resolved?.key ?? RAPID_MLX_LOCAL_API_KEY },
      resolveApiKey: async () => resolved ?? { key: RAPID_MLX_LOCAL_API_KEY, source: "flag" },
      toApiKeyCredential: (params) => {
        credential = ctx.toApiKeyCredential(params);
        return credential;
      },
    },
    providerId: RAPID_MLX_PROVIDER_ID,
    providerLabel: "Rapid-MLX",
    defaultBaseUrl: listing.provider.baseUrl,
    defaultApiKeyEnvVar: RAPID_MLX_API_KEY_ENV_VAR,
    modelPlaceholder: modelId,
  });
  if (!config?.models?.providers?.["rapid-mlx"]) {
    return null;
  }
  config.models.providers["rapid-mlx"] = {
    ...connectionProvider(listing, ctx.config),
    auth: credential?.keyRef ? "api-key" : listing.provider.auth,
    apiKey:
      credential?.keyRef ??
      (resolved
        ? resolved.key === RAPID_MLX_LOCAL_API_KEY
          ? RAPID_MLX_LOCAL_API_KEY
          : resolved.source === "profile"
            ? listing.provider.apiKey
            : "rapid-mlx:default"
        : listing.provider.apiKey),
  };
  return config;
}

async function listRapidMlxModels(params: {
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
  const configured = params.config.models?.providers?.[RAPID_MLX_PROVIDER_ID];
  const baseUrl = (params.baseUrl ?? configured?.baseUrl ?? RAPID_MLX_DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  // Saved endpoint credentials must never follow a URL entered during setup.
  let existing =
    (configured?.baseUrl ?? RAPID_MLX_DEFAULT_BASE_URL).trim().replace(/\/+$/, "") === baseUrl
      ? configured
      : undefined;
  if (params.replaceAuth && existing) {
    existing = withoutRapidMlxAuthentication(existing);
  }
  const request =
    existing?.request ??
    (configured?.request?.allowPrivateNetwork !== undefined
      ? { allowPrivateNetwork: configured.request.allowPrivateNetwork }
      : undefined);
  try {
    const { headers, hasHeaderAuth } = await resolveRapidMlxHeaders(params, existing);
    const configuredKey =
      params.apiKey === undefined && !hasHeaderAuth
        ? await resolveRapidMlxSecret(params, existing?.apiKey, "models.providers.rapid-mlx.apiKey")
        : undefined;
    const profileKey =
      configuredKey &&
      configuredKey !== RAPID_MLX_LOCAL_API_KEY &&
      typeof existing?.apiKey === "string" &&
      (configuredKey !== RAPID_MLX_API_KEY_ENV_VAR || !params.env[RAPID_MLX_API_KEY_ENV_VAR])
        ? (
            await (
              await import("openclaw/plugin-sdk/provider-auth-runtime")
            ).resolveApiKeyForProvider({
              provider: RAPID_MLX_PROVIDER_ID,
              // Catalog probes must keep the configured key ahead of ambient credentials.
              cfg: {
                ...params.config,
                models: {
                  ...params.config.models,
                  providers: {
                    ...params.config.models?.providers,
                    [RAPID_MLX_PROVIDER_ID]: {
                      ...existing,
                      baseUrl,
                      auth: "api-key",
                      models: existing?.models ?? [],
                    },
                  },
                },
              },
              agentDir: params.agentDir,
              allowAuthProfileFallback: configuredKey === RAPID_MLX_API_KEY_ENV_VAR,
            })
          ).apiKey
        : undefined;
    const apiKey =
      params.apiKey ??
      profileKey ??
      (configuredKey === RAPID_MLX_API_KEY_ENV_VAR
        ? params.env[RAPID_MLX_API_KEY_ENV_VAR]
        : configuredKey) ??
      params.env[RAPID_MLX_API_KEY_ENV_VAR];
    const result = await discoverOpenAICompatibleLocalModels({
      baseUrl,
      apiKey: hasHeaderAuth || apiKey === RAPID_MLX_LOCAL_API_KEY ? undefined : apiKey,
      headers,
      allowPrivateNetwork: request?.allowPrivateNetwork,
      label: "Rapid-MLX",
      discoverRuntimeContext: false,
      rawResult: true,
      signal: params.signal,
    });
    params.signal?.throwIfAborted();
    if (result.kind !== "success") {
      if (params.strict) {
        throw result.kind === "http-error"
          ? new LiveModelCatalogHttpError(RAPID_MLX_PROVIDER_ID, result.status)
          : new Error("Rapid-MLX model discovery unavailable. Check the server URL and API key.");
      }
      return null;
    }
    // Rapid-MLX reports the native window separately from its served ceiling.
    // Normalize once so automatic selection and the shared projection agree.
    const rows = result.rows;
    for (const { model } of rows) {
      const ceiling = readLiveModelCatalogPositiveSafeIntegerField(model, "max_model_len");
      if (ceiling !== undefined) {
        const native = readLiveModelCatalogPositiveSafeIntegerField(model, "context_window");
        model.context_window = Math.min(ceiling, native ?? ceiling);
      }
    }
    const provider: ModelProviderConfig = {
      ...existing,
      baseUrl,
      api: "openai-completions",
      apiKey: existing?.apiKey ?? (apiKey ? RAPID_MLX_API_KEY_ENV_VAR : RAPID_MLX_LOCAL_API_KEY),
      ...(request ? { request } : {}),
      models: existing?.models ?? [],
    };
    // Use the shared chat projection; memory setup selects embedding models separately.
    provider.models = buildOpenAICompatibleLiveModels(
      rows.map(({ model }) => model),
      provider,
    );
    return { provider, rows };
  } catch (error) {
    params.signal?.throwIfAborted();
    if (params.strict) {
      throw error;
    }
    return null;
  }
}

export async function discoverRapidMlxProvider(ctx: ProviderCatalogContext) {
  if (ctx.providerIds && !ctx.providerIds.includes(RAPID_MLX_PROVIDER_ID)) {
    return null;
  }
  if (
    !ctx.providerIds &&
    !ctx.config.models?.providers?.["rapid-mlx"] &&
    !ctx.env[RAPID_MLX_API_KEY_ENV_VAR]
  ) {
    return null;
  }
  const configuredKey = ctx.config.models?.providers?.["rapid-mlx"]?.apiKey;
  const auth =
    configuredKey === undefined ? ctx.resolveProviderApiKey(RAPID_MLX_PROVIDER_ID) : undefined;
  const result = await runLiveProviderCatalog({
    providerId: RAPID_MLX_PROVIDER_ID,
    run: async () => {
      const listing = await listRapidMlxModels({
        ...ctx,
        apiKey: auth?.discoveryApiKey,
        strict: true,
      });
      if (!listing) {
        throw new Error("Rapid-MLX model discovery unavailable");
      }
      return {
        provider: {
          ...listing.provider,
          apiKey: configuredKey ?? auth?.apiKey ?? listing.provider.apiKey,
        },
        outcomes: [
          {
            provider: RAPID_MLX_PROVIDER_ID,
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
