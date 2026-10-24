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
  selectPreferredLocalModelId,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  configureOpenAICompatibleSelfHostedProviderNonInteractive,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-setup";
import {
  OMLX_API_KEY_ENV_VAR,
  OMLX_DEFAULT_BASE_URL,
  OMLX_LOCAL_API_KEY,
  OMLX_PROVIDER_ID,
} from "./defaults.js";
import { listOmlxModels } from "./models.js";

export { discoverOmlxProvider } from "./models.js";

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
