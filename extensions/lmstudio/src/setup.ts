import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/config-runtime";
import {
  buildApiKeyCredential,
  ensureApiKeyFromEnvOrPrompt,
  normalizeOptionalSecretInput,
  type OpenClawConfig,
  type SecretInput,
  type SecretInputMode,
} from "openclaw/plugin-sdk/provider-auth";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { withAgentModelAliases } from "openclaw/plugin-sdk/provider-onboard";
import {
  configureOpenAICompatibleSelfHostedProviderNonInteractive,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderCatalogContext,
  type ProviderPrepareDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/provider-setup";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input";
import { WizardCancelledError, type WizardPrompter } from "openclaw/plugin-sdk/setup";
import {
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
  LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
  LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
  LMSTUDIO_MODEL_PLACEHOLDER,
  LMSTUDIO_DEFAULT_BASE_URL,
  LMSTUDIO_PROVIDER_LABEL,
  LMSTUDIO_DEFAULT_MODEL_ID,
  LMSTUDIO_PROVIDER_ID as PROVIDER_ID,
} from "./defaults.js";
import { discoverLmstudioModels, fetchLmstudioModels } from "./models.fetch.js";
import {
  mapLmstudioWireModelsToConfig,
  type LmstudioModelWire,
  resolveLmstudioInferenceBase,
} from "./models.js";
import {
  hasLmstudioAuthorizationHeader,
  resolveLmstudioProviderAuthMode,
  shouldUseLmstudioApiKeyPlaceholder,
} from "./provider-auth.js";
import { resolveLmstudioProviderHeaders, resolveLmstudioRequestContext } from "./runtime.js";

type ProviderPromptText = (params: {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string | undefined) => string | undefined;
}) => Promise<string | undefined>;

type ProviderPromptNote = (message: string, title?: string) => Promise<void> | void;
type LmstudioDiscoveryResult = Awaited<ReturnType<typeof fetchLmstudioModels>>;
type LmstudioSetupDiscovery = {
  discovery: LmstudioDiscoveryResult;
  models: ModelDefinitionConfig[];
  defaultModel: string | undefined;
  defaultModelId: string | undefined;
};

function resolvePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const normalized = Number.parseInt(trimmed, 10);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : undefined;
}

function buildLmstudioSetupProviderConfig(params: {
  existingProvider: ModelProviderConfig | undefined;
  sharedProvider?: ModelProviderConfig;
  baseUrl: string;
  apiKey?: ModelProviderConfig["apiKey"];
  headers: ModelProviderConfig["headers"] | undefined;
  models: ModelDefinitionConfig[];
}): ModelProviderConfig {
  return {
    ...params.existingProvider,
    ...params.sharedProvider,
    baseUrl: params.baseUrl,
    api: params.sharedProvider?.api ?? params.existingProvider?.api ?? "openai-completions",
    auth: "api-key",
    ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
    headers: params.headers,
    models: params.models,
  };
}

function resolveLmstudioModelAdvertisedContextLimit(entry: LmstudioModelWire): number | undefined {
  const raw = entry.max_context_length;
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return undefined;
  }
  return Math.floor(raw);
}

function applyModelContextWindowOverride(
  model: ModelDefinitionConfig,
  contextWindow: number,
): ModelDefinitionConfig {
  return {
    ...model,
    contextWindow,
    maxTokens: Math.min(model.maxTokens, contextWindow),
  };
}

function applyRequestedContextWindowToAllModels(params: {
  models: ModelDefinitionConfig[];
  discoveryModels: LmstudioModelWire[];
  requestedContextWindow?: number;
}): ModelDefinitionConfig[] {
  const requestedContextWindow = params.requestedContextWindow;
  if (!requestedContextWindow) {
    return params.models;
  }
  const contextLimitByModelId = new Map(
    params.discoveryModels
      .map((entry) => {
        const modelId = entry.key?.trim();
        if (!modelId) {
          return null;
        }
        return [modelId, resolveLmstudioModelAdvertisedContextLimit(entry)] as const;
      })
      .filter((entry): entry is readonly [string, number | undefined] => Boolean(entry)),
  );
  return params.models.map((model) =>
    applyModelContextWindowOverride(
      model,
      Math.min(
        requestedContextWindow,
        contextLimitByModelId.get(model.id) ?? requestedContextWindow,
      ),
    ),
  );
}

function resolveLmstudioDiscoveryFailure(params: {
  baseUrl: string;
  discovery: LmstudioDiscoveryResult;
}): { noteLines: [string, string]; reason: string } | null {
  const { baseUrl, discovery } = params;
  if (!discovery.reachable) {
    return {
      noteLines: [
        `LM Studio could not be reached at ${baseUrl}.`,
        "Start LM Studio (or run lms server start) and re-run setup.",
      ],
      reason: "LM Studio not reachable",
    };
  }
  if (discovery.status !== undefined && discovery.status >= 400) {
    return {
      noteLines: [
        `LM Studio returned HTTP ${discovery.status} while listing models at ${baseUrl}.`,
        "Check the base URL and API key, then re-run setup.",
      ],
      reason: `LM Studio discovery failed (${discovery.status})`,
    };
  }
  const hasUsableModel = discovery.models.some(
    (model) => model.type === "llm" && Boolean(model.key?.trim()),
  );
  if (!hasUsableModel) {
    return {
      noteLines: [
        `No LM Studio LLM models were found at ${baseUrl}.`,
        "Load at least one model in LM Studio (or run lms load), then re-run setup.",
      ],
      reason: "No LM Studio models found",
    };
  }
  return null;
}

function resolvePersistedLmstudioApiKey(params: {
  currentApiKey: ModelProviderConfig["apiKey"] | undefined;
  explicitAuth: ModelProviderConfig["auth"] | undefined;
  fallbackApiKey: ModelProviderConfig["apiKey"] | undefined;
  preferFallbackApiKey?: boolean;
  hasModels: boolean;
  hasAuthorizationHeader?: boolean;
}): ModelProviderConfig["apiKey"] | undefined {
  if (params.explicitAuth === "api-key") {
    if (params.preferFallbackApiKey && params.fallbackApiKey !== undefined) {
      return params.fallbackApiKey;
    }
    if (resolveLmstudioProviderAuthMode(params.currentApiKey)) {
      return params.currentApiKey;
    }
    return params.fallbackApiKey;
  }
  return shouldUseLmstudioApiKeyPlaceholder({
    hasModels: params.hasModels,
    resolvedApiKey: params.currentApiKey,
    hasAuthorizationHeader: params.hasAuthorizationHeader,
  })
    ? LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER
    : undefined;
}

/** Keeps explicit model entries first and appends unique discovered entries. */
function mergeDiscoveredModels(params: {
  explicitModels?: ModelDefinitionConfig[];
  discoveredModels?: ModelDefinitionConfig[];
}): ModelDefinitionConfig[] {
  const explicitModels = Array.isArray(params.explicitModels) ? params.explicitModels : [];
  const discoveredModels = Array.isArray(params.discoveredModels) ? params.discoveredModels : [];
  if (explicitModels.length === 0) {
    return discoveredModels;
  }
  if (discoveredModels.length === 0) {
    return explicitModels;
  }

  const merged = [...explicitModels];
  const seen = new Set(explicitModels.map((model) => model.id.trim()).filter(Boolean));
  for (const model of discoveredModels) {
    const id = model.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    merged.push(model);
  }
  return merged;
}

async function discoverLmstudioProviderCatalog(params: {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  quiet: boolean;
}): Promise<ModelProviderConfig> {
  const baseUrl = resolveLmstudioInferenceBase(params.baseUrl);
  const models = await discoverLmstudioModels({
    baseUrl,
    apiKey: params.apiKey ?? "",
    headers: params.headers,
    quiet: params.quiet,
  });
  return {
    baseUrl,
    api: "openai-completions",
    models,
  };
}

/** Preserves existing allowlist metadata and appends discovered LM Studio model refs. */
function mergeDiscoveredLmstudioAllowlistEntries(params: {
  existing?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];
  discoveredModels: ModelDefinitionConfig[];
}) {
  return withAgentModelAliases(
    params.existing,
    params.discoveredModels
      .map((model) => model.id.trim())
      .filter(Boolean)
      .map((id) => `${PROVIDER_ID}/${id}`),
  );
}

function selectDefaultLmstudioModelId(
  discoveredModels: ModelDefinitionConfig[],
): string | undefined {
  const ids = discoveredModels.map((model) => model.id.trim()).filter(Boolean);
  if (ids.length === 0) {
    return undefined;
  }
  return ids.includes(LMSTUDIO_DEFAULT_MODEL_ID) ? LMSTUDIO_DEFAULT_MODEL_ID : ids[0];
}

async function discoverLmstudioSetupModels(params: {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<
  | { value: LmstudioSetupDiscovery }
  | { failure: NonNullable<ReturnType<typeof resolveLmstudioDiscoveryFailure>> }
> {
  const discovery = await fetchLmstudioModels({
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    ...(params.headers ? { headers: params.headers } : {}),
    timeoutMs: params.timeoutMs ?? 5000,
  });
  const failure = resolveLmstudioDiscoveryFailure({
    baseUrl: params.baseUrl,
    discovery,
  });
  if (failure) {
    return { failure };
  }
  const models = mapLmstudioWireModelsToConfig(discovery.models);
  const defaultModelId = selectDefaultLmstudioModelId(models);
  return {
    value: {
      discovery,
      models,
      defaultModel: defaultModelId ? `${PROVIDER_ID}/${defaultModelId}` : undefined,
      defaultModelId,
    },
  };
}

async function resolveExplicitLmstudioSecretRefDiscoveryApiKey(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  apiKey: ModelProviderConfig["apiKey"] | undefined;
}): Promise<string | undefined> {
  if (!isSecretRef(params.apiKey)) {
    return undefined;
  }
  const resolved = await resolveConfiguredSecretInputString({
    config: params.config,
    env: params.env,
    value: params.apiKey,
    path: "models.providers.lmstudio.apiKey",
    unresolvedReasonStyle: "detailed",
  });
  return normalizeOptionalSecretInput(resolved.value);
}

/** Interactive LM Studio setup with connectivity and model-availability checks. */
export async function promptAndConfigureLmstudioInteractive(params: {
  config: OpenClawConfig;
  prompter?: WizardPrompter;
  secretInputMode?: SecretInputMode;
  allowSecretRefPrompt?: boolean;
  promptText?: ProviderPromptText;
  note?: ProviderPromptNote;
}): Promise<ProviderAuthResult> {
  const promptText = params.prompter?.text ?? params.promptText;
  if (!promptText) {
    throw new Error("LM Studio interactive setup requires a text prompter.");
  }
  const note = params.prompter?.note ?? params.note;
  const baseUrlRaw = await promptText({
    message: `${LMSTUDIO_PROVIDER_LABEL} base URL`,
    initialValue: LMSTUDIO_DEFAULT_BASE_URL,
    placeholder: LMSTUDIO_DEFAULT_BASE_URL,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const baseUrl = resolveLmstudioInferenceBase(String(baseUrlRaw ?? ""));
  let credentialInput: SecretInput | undefined;
  let credentialMode: SecretInputMode | undefined;
  const implicitRefMode = params.allowSecretRefPrompt === false && !params.secretInputMode;
  const autoRefEnvKey = process.env[LMSTUDIO_DEFAULT_API_KEY_ENV_VAR]?.trim();
  const apiKey =
    params.prompter && implicitRefMode && autoRefEnvKey
      ? autoRefEnvKey
      : params.prompter
        ? await ensureApiKeyFromEnvOrPrompt({
            config: params.config,
            provider: PROVIDER_ID,
            envLabel: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
            promptMessage: `${LMSTUDIO_PROVIDER_LABEL} API key`,
            normalize: (value) => value.trim(),
            validate: (value) => (value.trim() ? undefined : "Required"),
            prompter: params.prompter,
            secretInputMode:
              params.allowSecretRefPrompt === false
                ? (params.secretInputMode ?? "plaintext")
                : params.secretInputMode,
            setCredential: async (apiKeyValue, mode) => {
              credentialInput = apiKeyValue;
              credentialMode = mode;
            },
          })
        : String(
            await promptText({
              message: `${LMSTUDIO_PROVIDER_LABEL} API key`,
              placeholder: "sk-... (or any non-empty string)",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
          ).trim();
  const credential = params.prompter
    ? buildApiKeyCredential(
        PROVIDER_ID,
        credentialInput ??
          (implicitRefMode && autoRefEnvKey ? `\${${LMSTUDIO_DEFAULT_API_KEY_ENV_VAR}}` : apiKey),
        undefined,
        credentialMode
          ? { secretInputMode: credentialMode }
          : implicitRefMode && autoRefEnvKey
            ? { secretInputMode: "ref" }
            : undefined,
      )
    : {
        type: "api_key" as const,
        provider: PROVIDER_ID,
        key: apiKey,
      };
  const existingProvider = params.config.models?.providers?.[PROVIDER_ID];
  // Auth setup updates auth/profile/provider model fields but does not mutate
  // user-provided header overrides. Runtime request assembly is the source of truth for auth.
  const persistedHeaders = existingProvider?.headers;
  const resolvedHeaders = await resolveLmstudioProviderHeaders({
    config: params.config,
    env: process.env,
    headers: persistedHeaders,
  });
  const setupDiscovery = await discoverLmstudioSetupModels({
    baseUrl,
    apiKey,
    ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
    timeoutMs: 5000,
  });
  if ("failure" in setupDiscovery) {
    await note?.(setupDiscovery.failure.noteLines.join("\n"), "LM Studio");
    throw new WizardCancelledError(setupDiscovery.failure.reason);
  }
  let discoveredModels = setupDiscovery.value.models;
  if (params.prompter) {
    const requestedRaw = await params.prompter.text({
      message: "Preferred context length to load LM Studio models with (optional)",
      placeholder: "e.g. 32768 (leave blank to skip)",
      validate: (value) =>
        value?.trim()
          ? resolvePositiveInteger(value)
            ? undefined
            : "Enter a positive integer token count"
          : undefined,
    });
    const requestedContextWindow = resolvePositiveInteger(requestedRaw);
    discoveredModels = applyRequestedContextWindowToAllModels({
      models: discoveredModels,
      discoveryModels: setupDiscovery.value.discovery.models,
      requestedContextWindow,
    });
  }
  const allowlistEntries = mergeDiscoveredLmstudioAllowlistEntries({
    existing: params.config.agents?.defaults?.models,
    discoveredModels,
  });
  const defaultModel = setupDiscovery.value.defaultModel;
  const persistedApiKey =
    resolvePersistedLmstudioApiKey({
      currentApiKey: existingProvider?.apiKey,
      explicitAuth: "api-key",
      fallbackApiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
      preferFallbackApiKey: true,
      hasModels: discoveredModels.length > 0,
      hasAuthorizationHeader: hasLmstudioAuthorizationHeader(resolvedHeaders),
    }) ?? LMSTUDIO_DEFAULT_API_KEY_ENV_VAR;

  return {
    profiles: [
      {
        profileId: `${PROVIDER_ID}:default`,
        credential,
      },
    ],
    configPatch: {
      agents: {
        defaults: {
          models: allowlistEntries,
        },
      },
      models: {
        // Respect existing global mode; self-hosted provider setup should merge by default.
        mode: params.config.models?.mode ?? "merge",
        providers: {
          [PROVIDER_ID]: buildLmstudioSetupProviderConfig({
            existingProvider,
            baseUrl,
            apiKey: persistedApiKey,
            headers: persistedHeaders,
            models: discoveredModels,
          }),
        },
      },
    },
    defaultModel,
  };
}

/** Non-interactive setup path backed by the shared self-hosted helper. */
export async function configureLmstudioNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<OpenClawConfig | null> {
  const customBaseUrl = normalizeOptionalSecretInput(ctx.opts.customBaseUrl);
  const baseUrl = resolveLmstudioInferenceBase(
    customBaseUrl || LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
  );
  const normalizedCtx = customBaseUrl
    ? {
        ...ctx,
        opts: {
          ...ctx.opts,
          customBaseUrl: baseUrl,
        },
      }
    : ctx;
  const configureShared = async (configureCtx: ProviderAuthMethodNonInteractiveContext) =>
    await configureOpenAICompatibleSelfHostedProviderNonInteractive({
      ctx: configureCtx,
      providerId: PROVIDER_ID,
      providerLabel: LMSTUDIO_PROVIDER_LABEL,
      defaultBaseUrl: LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
      defaultApiKeyEnvVar: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
      modelPlaceholder: LMSTUDIO_MODEL_PLACEHOLDER,
    });
  const requestedModelId = normalizeOptionalSecretInput(normalizedCtx.opts.customModelId);
  const resolved = await normalizedCtx.resolveApiKey({
    provider: PROVIDER_ID,
    flagValue:
      normalizeOptionalSecretInput(normalizedCtx.opts.lmstudioApiKey) ??
      normalizeOptionalSecretInput(normalizedCtx.opts.customApiKey),
    flagName:
      normalizeOptionalSecretInput(normalizedCtx.opts.lmstudioApiKey) !== undefined
        ? "--lmstudio-api-key"
        : "--custom-api-key",
    envVar: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    envVarName: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    required: false,
  });
  const resolvedOrSynthetic = resolved ?? {
    key: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
    source: "flag",
  };

  const existingProvider = normalizedCtx.config.models?.providers?.[PROVIDER_ID];
  // Auth setup updates auth/profile/provider model fields but does not mutate
  // user-provided header overrides. Runtime request assembly is the source of truth for auth.
  const persistedHeaders = existingProvider?.headers;
  const resolvedHeaders = await resolveLmstudioProviderHeaders({
    config: normalizedCtx.config,
    env: process.env,
    headers: persistedHeaders,
  });
  const setupDiscovery = await discoverLmstudioSetupModels({
    baseUrl,
    apiKey: resolvedOrSynthetic.key,
    ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
    timeoutMs: 5000,
  });
  if ("failure" in setupDiscovery) {
    normalizedCtx.runtime.error(setupDiscovery.failure.noteLines.join("\n"));
    normalizedCtx.runtime.exit(1);
    return null;
  }
  const discoveredModels = setupDiscovery.value.models;
  const selectedModelId = requestedModelId ?? setupDiscovery.value.defaultModelId;
  const selectedModel = selectedModelId
    ? discoveredModels.find((model) => model.id === selectedModelId)
    : undefined;
  if (!selectedModelId || !selectedModel) {
    const availableModels = discoveredModels.map((model) => model.id).join(", ");
    normalizedCtx.runtime.error(
      requestedModelId
        ? [
            `LM Studio model ${requestedModelId} was not found at ${baseUrl}.`,
            `Available models: ${availableModels}`,
          ].join("\n")
        : [
            `LM Studio did not expose a usable default model at ${baseUrl}.`,
            `Available models: ${availableModels || "(none)"}`,
          ].join("\n"),
    );
    normalizedCtx.runtime.exit(1);
    return null;
  }

  // Delegate to the shared helper even when modelId is set so that onboarding
  // state and credential storage are handled consistently. The pre-resolved key
  // is injected via resolveApiKey to skip a second prompt. The returned config
  // is then post-patched below to add the discovered model list and base URL.
  const configured = await configureShared({
    ...normalizedCtx,
    opts: {
      ...normalizedCtx.opts,
      customModelId: selectedModelId,
    },
    resolveApiKey: async () => resolvedOrSynthetic,
  });
  if (!configured) {
    return null;
  }
  const sharedProvider = configured.models?.providers?.[PROVIDER_ID];
  const resolvedSyntheticLocalKey = resolvedOrSynthetic.key === LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER;
  const persistedApiKey = resolvePersistedLmstudioApiKey({
    // If this run resolved to keyless local mode, avoid preserving stale env markers.
    currentApiKey: resolvedSyntheticLocalKey ? undefined : existingProvider?.apiKey,
    explicitAuth: "api-key",
    fallbackApiKey: resolvedSyntheticLocalKey
      ? LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER
      : (configured.models?.providers?.[PROVIDER_ID]?.apiKey ?? LMSTUDIO_DEFAULT_API_KEY_ENV_VAR),
    preferFallbackApiKey: true,
    hasModels: discoveredModels.length > 0,
    hasAuthorizationHeader: hasLmstudioAuthorizationHeader(resolvedHeaders),
  });

  return {
    ...configured,
    models: {
      ...configured.models,
      providers: {
        ...configured.models?.providers,
        [PROVIDER_ID]: buildLmstudioSetupProviderConfig({
          existingProvider,
          sharedProvider,
          baseUrl,
          apiKey: persistedApiKey,
          headers: persistedHeaders,
          models: discoveredModels,
        }),
      },
    },
  };
}

/** Discovers provider settings, merging explicit config with live model discovery. */
export async function discoverLmstudioProvider(ctx: ProviderCatalogContext): Promise<{
  provider: ModelProviderConfig;
} | null> {
  const explicit = ctx.config.models?.providers?.[PROVIDER_ID];
  const explicitAuth = explicit?.auth;
  let explicitWithoutHeaders: Omit<ModelProviderConfig, "headers" | "auth"> | undefined;
  if (explicit) {
    const { headers: _headers, auth: _auth, ...rest } = explicit;
    explicitWithoutHeaders = rest;
  }
  const hasExplicitModels = Array.isArray(explicit?.models) && explicit.models.length > 0;
  const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
  const explicitSecretRefDiscoveryApiKey = await resolveExplicitLmstudioSecretRefDiscoveryApiKey({
    config: ctx.config,
    env: ctx.env,
    apiKey: explicit?.apiKey,
  });
  const resolvedDiscoveryApiKey = discoveryApiKey ?? explicitSecretRefDiscoveryApiKey;
  const resolvedHeaders = await resolveLmstudioProviderHeaders({
    config: ctx.config,
    env: ctx.env,
    headers: explicit?.headers,
  });
  // CLI/runtime-resolved key takes precedence over static provider config key.
  const resolvedApiKey = apiKey ?? explicit?.apiKey;
  if (hasExplicitModels && explicitWithoutHeaders) {
    const persistedApiKey = resolvePersistedLmstudioApiKey({
      currentApiKey: resolvedApiKey,
      explicitAuth,
      fallbackApiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
      hasModels: hasExplicitModels,
      hasAuthorizationHeader: hasLmstudioAuthorizationHeader(resolvedHeaders),
    });
    const persistedAuth = resolveLmstudioProviderAuthMode(persistedApiKey);
    return {
      provider: {
        ...explicitWithoutHeaders,
        ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
        baseUrl: resolveLmstudioInferenceBase(explicitWithoutHeaders.baseUrl),
        // Keep explicit API unless absent, then fall back to provider default.
        api: explicitWithoutHeaders.api ?? "openai-completions",
        ...(persistedApiKey ? { apiKey: persistedApiKey } : {}),
        ...(persistedAuth ? { auth: persistedAuth } : {}),
        models: explicitWithoutHeaders.models,
      },
    };
  }
  const provider = await discoverLmstudioProviderCatalog({
    baseUrl: explicit?.baseUrl,
    // Prefer dedicated discovery key and then explicit SecretRef-backed provider keys.
    apiKey: resolvedDiscoveryApiKey,
    headers: resolvedHeaders,
    quiet: !apiKey && !explicit && !resolvedDiscoveryApiKey,
  });
  const models = mergeDiscoveredModels({
    explicitModels: explicit?.models,
    discoveredModels: provider.models,
  });
  if (models.length === 0 && !apiKey && !explicit?.apiKey) {
    return null;
  }
  const persistedApiKey = resolvePersistedLmstudioApiKey({
    currentApiKey: resolvedApiKey,
    explicitAuth,
    fallbackApiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    hasModels: models.length > 0,
    hasAuthorizationHeader: hasLmstudioAuthorizationHeader(resolvedHeaders),
  });
  const persistedAuth = resolveLmstudioProviderAuthMode(persistedApiKey);
  return {
    provider: {
      ...provider,
      ...explicitWithoutHeaders,
      ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
      baseUrl: resolveLmstudioInferenceBase(explicit?.baseUrl ?? provider.baseUrl),
      ...(persistedApiKey ? { apiKey: persistedApiKey } : {}),
      ...(persistedAuth ? { auth: persistedAuth } : {}),
      models,
    },
  };
}

export async function prepareLmstudioDynamicModels(
  ctx: ProviderPrepareDynamicModelContext,
): Promise<ProviderRuntimeModel[]> {
  const baseUrl = resolveLmstudioInferenceBase(ctx.providerConfig?.baseUrl);
  const { apiKey, headers } = await resolveLmstudioRequestContext({
    config: ctx.config,
    agentDir: ctx.agentDir,
    env: process.env,
    providerHeaders: ctx.providerConfig?.headers,
  });
  const discoveredModels = await discoverLmstudioModels({
    baseUrl,
    apiKey: apiKey ?? "",
    headers,
    quiet: true,
  });
  return discoveredModels.map((model) => ({
    ...model,
    provider: PROVIDER_ID,
    api: ctx.providerConfig?.api ?? "openai-completions",
    baseUrl,
  }));
}
