import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.js";
import {
  applyProviderResolvedModelCompatWithPlugins,
  applyProviderResolvedTransportWithPlugin,
  buildProviderUnknownModelHintWithPlugin,
  clearProviderRuntimeHookCache,
  normalizeProviderTransportWithPlugin,
  prepareProviderDynamicModel,
  runProviderDynamicModel,
  normalizeProviderResolvedModelWithPlugin,
} from "../../plugins/provider-runtime.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { isSecretRefHeaderValueMarker } from "../model-auth-markers.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../model-selection.js";
import {
  buildSuppressedBuiltInModelError,
  shouldSuppressBuiltInModel,
} from "../model-suppression.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
import { normalizeResolvedProviderModel } from "./model.provider-normalization.js";

type InlineModelEntry = Omit<ModelDefinitionConfig, "api"> & {
  api?: Api;
  provider: string;
  baseUrl?: string;
  headers?: Record<string, string>;
};
type InlineProviderConfig = {
  baseUrl?: string;
  api?: ModelDefinitionConfig["api"];
  models?: ModelDefinitionConfig[];
  headers?: unknown;
};

type ProviderRuntimeHooks = {
  applyProviderResolvedModelCompatWithPlugins?: (
    params: Parameters<typeof applyProviderResolvedModelCompatWithPlugins>[0],
  ) => unknown;
  applyProviderResolvedTransportWithPlugin?: (
    params: Parameters<typeof applyProviderResolvedTransportWithPlugin>[0],
  ) => unknown;
  buildProviderUnknownModelHintWithPlugin: (
    params: Parameters<typeof buildProviderUnknownModelHintWithPlugin>[0],
  ) => string | undefined;
  prepareProviderDynamicModel: (
    params: Parameters<typeof prepareProviderDynamicModel>[0],
  ) => Promise<void>;
  runProviderDynamicModel: (params: Parameters<typeof runProviderDynamicModel>[0]) => unknown;
  normalizeProviderResolvedModelWithPlugin: (
    params: Parameters<typeof normalizeProviderResolvedModelWithPlugin>[0],
  ) => unknown;
  normalizeProviderTransportWithPlugin: (
    params: Parameters<typeof normalizeProviderTransportWithPlugin>[0],
  ) => unknown;
};

const DEFAULT_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  applyProviderResolvedModelCompatWithPlugins,
  applyProviderResolvedTransportWithPlugin,
  buildProviderUnknownModelHintWithPlugin,
  prepareProviderDynamicModel,
  runProviderDynamicModel,
  normalizeProviderResolvedModelWithPlugin,
  normalizeProviderTransportWithPlugin,
};

const STATIC_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  applyProviderResolvedModelCompatWithPlugins: () => undefined,
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => {},
  runProviderDynamicModel: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
};

function resolveRuntimeHooks(params?: {
  runtimeHooks?: ProviderRuntimeHooks;
  skipProviderRuntimeHooks?: boolean;
}): ProviderRuntimeHooks {
  if (params?.skipProviderRuntimeHooks) {
    return STATIC_PROVIDER_RUNTIME_HOOKS;
  }
  return params?.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
}

function normalizeResolvedTransportApi(api: unknown): ModelDefinitionConfig["api"] | undefined {
  switch (api) {
    case "anthropic-messages":
    case "bedrock-converse-stream":
    case "github-copilot":
    case "google-generative-ai":
    case "ollama":
    case "openai-codex-responses":
    case "openai-completions":
    case "openai-responses":
    case "azure-openai-responses":
      return api;
    default:
      return undefined;
  }
}

function sanitizeModelHeaders(
  headers: unknown,
  opts?: { stripSecretRefMarkers?: boolean },
): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") {
      continue;
    }
    if (opts?.stripSecretRefMarkers && isSecretRefHeaderValueMarker(headerValue)) {
      continue;
    }
    next[headerName] = headerValue;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function applyResolvedTransportFallback(params: {
  provider: string;
  cfg?: OpenClawConfig;
  runtimeHooks: ProviderRuntimeHooks;
  model: Model<Api>;
}): Model<Api> | undefined {
  const normalized = params.runtimeHooks.normalizeProviderTransportWithPlugin({
    provider: params.provider,
    config: params.cfg,
    context: {
      provider: params.provider,
      api: params.model.api,
      baseUrl: params.model.baseUrl,
    },
  }) as { api?: Api | null; baseUrl?: string } | undefined;
  if (!normalized) {
    return undefined;
  }
  const nextApi = normalizeResolvedTransportApi(normalized.api) ?? params.model.api;
  const nextBaseUrl = normalized.baseUrl ?? params.model.baseUrl;
  if (nextApi === params.model.api && nextBaseUrl === params.model.baseUrl) {
    return undefined;
  }
  return {
    ...params.model,
    api: nextApi,
    baseUrl: nextBaseUrl,
  };
}

function normalizeResolvedModel(params: {
  provider: string;
  model: Model<Api>;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model<Api> {
  const normalizedInputModel =
    Array.isArray(params.model.input) && params.model.input.length > 0
      ? params.model
      : ({
          ...params.model,
          input: ["text"],
        } as Model<Api>);
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const pluginNormalized = runtimeHooks.normalizeProviderResolvedModelWithPlugin({
    provider: params.provider,
    config: params.cfg,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      provider: params.provider,
      modelId: normalizedInputModel.id,
      model: normalizedInputModel,
    },
  }) as Model<Api> | undefined;
  const compatNormalized = runtimeHooks.applyProviderResolvedModelCompatWithPlugins?.({
    provider: params.provider,
    config: params.cfg,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      provider: params.provider,
      modelId: normalizedInputModel.id,
      model: (pluginNormalized ?? normalizedInputModel) as never,
    },
  }) as Model<Api> | undefined;
  const transportNormalized = runtimeHooks.applyProviderResolvedTransportWithPlugin?.({
    provider: params.provider,
    config: params.cfg,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      provider: params.provider,
      modelId: normalizedInputModel.id,
      model: (compatNormalized ?? pluginNormalized ?? normalizedInputModel) as never,
    },
  }) as Model<Api> | undefined;
  const fallbackTransportNormalized =
    transportNormalized ??
    applyResolvedTransportFallback({
      provider: params.provider,
      cfg: params.cfg,
      runtimeHooks,
      model: compatNormalized ?? pluginNormalized ?? normalizedInputModel,
    });
  return normalizeResolvedProviderModel({
    provider: params.provider,
    model:
      fallbackTransportNormalized ?? compatNormalized ?? pluginNormalized ?? normalizedInputModel,
  });
}

function resolveProviderTransport(params: {
  provider: string;
  api?: Api | null;
  baseUrl?: string;
  cfg?: OpenClawConfig;
  runtimeHooks?: ProviderRuntimeHooks;
}): {
  api?: Api;
  baseUrl?: string;
} {
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const normalized = runtimeHooks.normalizeProviderTransportWithPlugin({
    provider: params.provider,
    config: params.cfg,
    context: {
      provider: params.provider,
      api: params.api,
      baseUrl: params.baseUrl,
    },
  }) as { api?: Api | null; baseUrl?: string } | undefined;

  return {
    api: normalizeResolvedTransportApi(normalized?.api ?? params.api),
    baseUrl: normalized?.baseUrl ?? params.baseUrl,
  };
}

function findInlineModelMatch(params: {
  providers: Record<string, InlineProviderConfig>;
  provider: string;
  modelId: string;
}) {
  const inlineModels = buildInlineProviderModels(params.providers);
  const exact = inlineModels.find(
    (entry) => entry.provider === params.provider && entry.id === params.modelId,
  );
  if (exact) {
    return exact;
  }
  const normalizedProvider = normalizeProviderId(params.provider);
  return inlineModels.find(
    (entry) =>
      normalizeProviderId(entry.provider) === normalizedProvider && entry.id === params.modelId,
  );
}

export { buildModelAliasLines };

function resolveConfiguredProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string,
): InlineProviderConfig | undefined {
  const configuredProviders = cfg?.models?.providers;
  if (!configuredProviders) {
    return undefined;
  }
  const exactProviderConfig = configuredProviders[provider];
  if (exactProviderConfig) {
    return exactProviderConfig;
  }
  return findNormalizedProviderValue(configuredProviders, provider);
}

function applyConfiguredProviderOverrides(params: {
  provider: string;
  discoveredModel: Model<Api>;
  providerConfig?: InlineProviderConfig;
  modelId: string;
  cfg?: OpenClawConfig;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model<Api> {
  const { discoveredModel, providerConfig, modelId } = params;
  if (!providerConfig) {
    return {
      ...discoveredModel,
      // Discovered models originate from models.json and may contain persistence markers.
      headers: sanitizeModelHeaders(discoveredModel.headers, { stripSecretRefMarkers: true }),
    };
  }
  const configuredModel = providerConfig.models?.find((candidate) => candidate.id === modelId);
  const discoveredHeaders = sanitizeModelHeaders(discoveredModel.headers, {
    stripSecretRefMarkers: true,
  });
  const providerHeaders = sanitizeModelHeaders(providerConfig.headers, {
    stripSecretRefMarkers: true,
  });
  const configuredHeaders = sanitizeModelHeaders(configuredModel?.headers, {
    stripSecretRefMarkers: true,
  });
  if (!configuredModel && !providerConfig.baseUrl && !providerConfig.api && !providerHeaders) {
    return {
      ...discoveredModel,
      headers: discoveredHeaders,
    };
  }
  const resolvedInput = configuredModel?.input ?? discoveredModel.input;
  const normalizedInput =
    Array.isArray(resolvedInput) && resolvedInput.length > 0
      ? resolvedInput.filter((item) => item === "text" || item === "image")
      : (["text"] as Array<"text" | "image">);

  const resolvedTransport = resolveProviderTransport({
    provider: params.provider,
    api: configuredModel?.api ?? providerConfig.api ?? discoveredModel.api,
    baseUrl: providerConfig.baseUrl ?? discoveredModel.baseUrl,
    cfg: params.cfg,
    runtimeHooks: params.runtimeHooks,
  });
  return {
    ...discoveredModel,
    api:
      resolvedTransport.api ??
      normalizeResolvedTransportApi(discoveredModel.api) ??
      "openai-responses",
    baseUrl: resolvedTransport.baseUrl ?? discoveredModel.baseUrl,
    reasoning: configuredModel?.reasoning ?? discoveredModel.reasoning,
    input: normalizedInput,
    cost: configuredModel?.cost ?? discoveredModel.cost,
    contextWindow: configuredModel?.contextWindow ?? discoveredModel.contextWindow,
    maxTokens: configuredModel?.maxTokens ?? discoveredModel.maxTokens,
    headers:
      discoveredHeaders || providerHeaders || configuredHeaders
        ? {
            ...discoveredHeaders,
            ...providerHeaders,
            ...configuredHeaders,
          }
        : undefined,
    compat: configuredModel?.compat ?? discoveredModel.compat,
  };
}

export function buildInlineProviderModels(
  providers: Record<string, InlineProviderConfig>,
): InlineModelEntry[] {
  return Object.entries(providers).flatMap(([providerId, entry]) => {
    const trimmed = providerId.trim();
    if (!trimmed) {
      return [];
    }
    const providerHeaders = sanitizeModelHeaders(entry?.headers, {
      stripSecretRefMarkers: true,
    });
    return (entry?.models ?? []).map((model) => {
      const transport = resolveProviderTransport({
        provider: trimmed,
        api: model.api ?? entry?.api,
        baseUrl: entry?.baseUrl,
      });
      return {
        ...model,
        provider: trimmed,
        baseUrl: transport.baseUrl,
        api: transport.api ?? model.api,
        headers: (() => {
          const modelHeaders = sanitizeModelHeaders((model as InlineModelEntry).headers, {
            stripSecretRefMarkers: true,
          });
          if (!providerHeaders && !modelHeaders) {
            return undefined;
          }
          return {
            ...providerHeaders,
            ...modelHeaders,
          };
        })(),
      };
    });
  });
}

function resolveExplicitModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): { kind: "resolved"; model: Model<Api> } | { kind: "suppressed" } | undefined {
  const { provider, modelId, modelRegistry, cfg, agentDir, runtimeHooks } = params;
  if (shouldSuppressBuiltInModel({ provider, id: modelId })) {
    return { kind: "suppressed" };
  }
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const inlineMatch = findInlineModelMatch({
    providers: cfg?.models?.providers ?? {},
    provider,
    modelId,
  });
  if (inlineMatch?.api) {
    return {
      kind: "resolved",
      model: normalizeResolvedModel({
        provider,
        cfg,
        agentDir,
        model: inlineMatch as Model<Api>,
        runtimeHooks,
      }),
    };
  }
  const model = modelRegistry.find(provider, modelId) as Model<Api> | null;

  if (model) {
    return {
      kind: "resolved",
      model: normalizeResolvedModel({
        provider,
        cfg,
        agentDir,
        model: applyConfiguredProviderOverrides({
          provider,
          discoveredModel: model,
          providerConfig,
          modelId,
          cfg,
          runtimeHooks,
        }),
        runtimeHooks,
      }),
    };
  }

  const providers = cfg?.models?.providers ?? {};
  const fallbackInlineMatch = findInlineModelMatch({
    providers,
    provider,
    modelId,
  });
  if (fallbackInlineMatch?.api) {
    return {
      kind: "resolved",
      model: normalizeResolvedModel({
        provider,
        cfg,
        agentDir,
        model: fallbackInlineMatch as Model<Api>,
        runtimeHooks,
      }),
    };
  }

  return undefined;
}

function resolvePluginDynamicModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model<Api> | undefined {
  const { provider, modelId, modelRegistry, cfg, agentDir } = params;
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const pluginDynamicModel = runtimeHooks.runProviderDynamicModel({
    provider,
    config: cfg,
    context: {
      config: cfg,
      agentDir,
      provider,
      modelId,
      modelRegistry,
      providerConfig,
    },
  }) as Model<Api> | undefined;
  if (!pluginDynamicModel) {
    return undefined;
  }
  const overriddenDynamicModel = applyConfiguredProviderOverrides({
    provider,
    discoveredModel: pluginDynamicModel,
    providerConfig,
    modelId,
    cfg,
    runtimeHooks,
  });
  return normalizeResolvedModel({
    provider,
    cfg,
    agentDir,
    model: overriddenDynamicModel,
    runtimeHooks,
  });
}

function resolveConfiguredFallbackModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model<Api> | undefined {
  const { provider, modelId, cfg, agentDir, runtimeHooks } = params;
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const configuredModel = providerConfig?.models?.find((candidate) => candidate.id === modelId);
  const providerHeaders = sanitizeModelHeaders(providerConfig?.headers, {
    stripSecretRefMarkers: true,
  });
  const modelHeaders = sanitizeModelHeaders(configuredModel?.headers, {
    stripSecretRefMarkers: true,
  });
  if (!providerConfig && !modelId.startsWith("mock-")) {
    return undefined;
  }
  const fallbackTransport = resolveProviderTransport({
    provider,
    api: providerConfig?.api ?? "openai-responses",
    baseUrl: providerConfig?.baseUrl,
    cfg,
    runtimeHooks,
  });
  return normalizeResolvedModel({
    provider,
    cfg,
    agentDir,
    model: {
      id: modelId,
      name: modelId,
      api: fallbackTransport.api ?? "openai-responses",
      provider,
      baseUrl: fallbackTransport.baseUrl,
      reasoning: configuredModel?.reasoning ?? false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow:
        configuredModel?.contextWindow ??
        providerConfig?.models?.[0]?.contextWindow ??
        DEFAULT_CONTEXT_TOKENS,
      maxTokens:
        configuredModel?.maxTokens ??
        providerConfig?.models?.[0]?.maxTokens ??
        DEFAULT_CONTEXT_TOKENS,
      headers:
        providerHeaders || modelHeaders ? { ...providerHeaders, ...modelHeaders } : undefined,
    } as Model<Api>,
    runtimeHooks,
  });
}

export function resolveModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model<Api> | undefined {
  const explicitModel = resolveExplicitModelWithRegistry(params);
  if (explicitModel?.kind === "suppressed") {
    return undefined;
  }
  if (explicitModel?.kind === "resolved") {
    return explicitModel.model;
  }

  const pluginDynamicModel = resolvePluginDynamicModelWithRegistry(params);
  if (pluginDynamicModel) {
    return pluginDynamicModel;
  }

  return resolveConfiguredFallbackModel(params);
}

export function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
  options?: {
    authStorage?: AuthStorage;
    modelRegistry?: ModelRegistry;
    runtimeHooks?: ProviderRuntimeHooks;
    skipProviderRuntimeHooks?: boolean;
  },
): {
  model?: Model<Api>;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();
  const authStorage = options?.authStorage ?? discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = options?.modelRegistry ?? discoverModels(authStorage, resolvedAgentDir);
  const runtimeHooks = resolveRuntimeHooks(options);
  const model = resolveModelWithRegistry({
    provider,
    modelId,
    modelRegistry,
    cfg,
    agentDir: resolvedAgentDir,
    runtimeHooks,
  });
  if (model) {
    return { model, authStorage, modelRegistry };
  }

  return {
    error: buildUnknownModelError({
      provider,
      modelId,
      cfg,
      agentDir: resolvedAgentDir,
      runtimeHooks,
    }),
    authStorage,
    modelRegistry,
  };
}

export async function resolveModelAsync(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
  options?: {
    authStorage?: AuthStorage;
    modelRegistry?: ModelRegistry;
    retryTransientProviderRuntimeMiss?: boolean;
    runtimeHooks?: ProviderRuntimeHooks;
    skipProviderRuntimeHooks?: boolean;
  },
): Promise<{
  model?: Model<Api>;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}> {
  const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();
  const authStorage = options?.authStorage ?? discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = options?.modelRegistry ?? discoverModels(authStorage, resolvedAgentDir);
  const runtimeHooks = resolveRuntimeHooks(options);
  const explicitModel = resolveExplicitModelWithRegistry({
    provider,
    modelId,
    modelRegistry,
    cfg,
    agentDir: resolvedAgentDir,
    runtimeHooks,
  });
  if (explicitModel?.kind === "suppressed") {
    return {
      error: buildUnknownModelError({
        provider,
        modelId,
        cfg,
        agentDir: resolvedAgentDir,
        runtimeHooks,
      }),
      authStorage,
      modelRegistry,
    };
  }
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const resolveDynamicAttempt = async (attemptOptions?: { clearHookCache?: boolean }) => {
    if (attemptOptions?.clearHookCache) {
      clearProviderRuntimeHookCache();
    }
    await runtimeHooks.prepareProviderDynamicModel({
      provider,
      config: cfg,
      context: {
        config: cfg,
        agentDir: resolvedAgentDir,
        provider,
        modelId,
        modelRegistry,
        providerConfig,
      },
    });
    return resolveModelWithRegistry({
      provider,
      modelId,
      modelRegistry,
      cfg,
      agentDir: resolvedAgentDir,
      runtimeHooks,
    });
  };
  let model =
    explicitModel?.kind === "resolved" ? explicitModel.model : await resolveDynamicAttempt();
  if (!model && !explicitModel && options?.retryTransientProviderRuntimeMiss) {
    // Startup can race the first provider-runtime snapshot load on a fresh
    // gateway boot. Retry once with a cleared hook cache before surfacing a
    // user-visible "Unknown model" that disappears on the next message.
    model = await resolveDynamicAttempt({ clearHookCache: true });
  }
  if (model) {
    return { model, authStorage, modelRegistry };
  }

  return {
    error: buildUnknownModelError({
      provider,
      modelId,
      cfg,
      agentDir: resolvedAgentDir,
      runtimeHooks,
    }),
    authStorage,
    modelRegistry,
  };
}

/**
 * Build a more helpful error when the model is not found.
 *
 * Some provider plugins only become available after setup/auth has registered
 * them. When users point `agents.defaults.model.primary` at one of those
 * providers before setup, the raw `Unknown model` error is too vague. Provider
 * plugins can append a targeted recovery hint here.
 *
 * See: https://github.com/openclaw/openclaw/issues/17328
 */
function buildUnknownModelError(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): string {
  const suppressed = buildSuppressedBuiltInModelError({
    provider: params.provider,
    id: params.modelId,
  });
  if (suppressed) {
    return suppressed;
  }
  const base = `Unknown model: ${params.provider}/${params.modelId}`;
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const hint = runtimeHooks.buildProviderUnknownModelHintWithPlugin({
    provider: params.provider,
    config: params.cfg,
    env: process.env,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      env: process.env,
      provider: params.provider,
      modelId: params.modelId,
    },
  });
  return hint ? `${base}. ${hint}` : base;
}
