import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "openclaw/plugin-sdk/provider-setup";
import {
  asPositiveSafeInteger,
  normalizeOptionalLowercaseString,
  normalizeTrimmedStringList,
  normalizeUniqueTrimmedStringList,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  LMSTUDIO_DEFAULT_BASE_URL,
  LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH,
  LMSTUDIO_PROVIDER_ID,
} from "./defaults.js";
import {
  buildLmstudioBinaryReasoningEffortMap,
  buildLmstudioReasoningEffortMap,
  LMSTUDIO_OPENAI_COMPAT_ENABLED_REASONING_EFFORTS,
  LMSTUDIO_OPENAI_COMPAT_REASONING_EFFORTS,
  normalizeLmstudioTransportReasoningCompat,
} from "./model-reasoning.js";

export type LmstudioModelWire = {
  type?: "llm" | "embedding";
  key?: string;
  display_name?: string;
  max_context_length?: number;
  format?: "gguf" | "mlx" | null;
  variants?: unknown;
  selected_variant?: unknown;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: LmstudioReasoningCapabilityWire;
  };
  loaded_instances?: Array<{
    id?: string;
    config?: {
      context_length?: number;
    } | null;
  } | null>;
};

type LmstudioReasoningCapabilityWire = {
  allowed_options?: unknown;
  default?: unknown;
};

function normalizeReasoningOptions(value: unknown): string[] {
  return uniqueStrings(normalizeTrimmedStringList(value).map((option) => option.toLowerCase()));
}

function isLmstudioBinaryReasoningOptions(allowedOptions: readonly string[]): boolean {
  return (
    allowedOptions.some((option) => option === "on") &&
    allowedOptions.every((option) => option === "on" || option === "off")
  );
}

function resolveLmstudioTransportReasoningEfforts(allowedOptions: readonly string[]): string[] {
  if (isLmstudioBinaryReasoningOptions(allowedOptions)) {
    return allowedOptions.includes("off")
      ? [...LMSTUDIO_OPENAI_COMPAT_REASONING_EFFORTS]
      : [...LMSTUDIO_OPENAI_COMPAT_ENABLED_REASONING_EFFORTS];
  }
  return uniqueStrings(
    allowedOptions
      .map((option) => (option === "off" ? "none" : option))
      .filter((option) => option !== "on"),
  );
}

export function resolveLmstudioReasoningCompat(
  entry: Pick<LmstudioModelWire, "capabilities">,
): ModelDefinitionConfig["compat"] | undefined {
  const supportedReasoningEfforts = resolveLmstudioTransportReasoningEfforts(
    normalizeReasoningOptions(entry.capabilities?.reasoning?.allowed_options),
  );
  if (!supportedReasoningEfforts.some((option) => option !== "none")) {
    return undefined;
  }
  const isBinary = isLmstudioBinaryReasoningOptions(
    normalizeReasoningOptions(entry.capabilities?.reasoning?.allowed_options),
  );
  return {
    supportsReasoningEffort: true,
    supportedReasoningEfforts,
    // Binary servers keep the graded ladder for the catalog but carry on/off
    // wire tokens, so graded requests are not rejected at the endpoint.
    reasoningEffortMap: isBinary
      ? buildLmstudioBinaryReasoningEffortMap(supportedReasoningEfforts.includes("none"))
      : buildLmstudioReasoningEffortMap(supportedReasoningEfforts),
  };
}

export function resolveLmstudioReasoningCapability(
  entry: Pick<LmstudioModelWire, "capabilities">,
): boolean {
  const reasoning = entry.capabilities?.reasoning;
  if (reasoning === undefined || reasoning === null) {
    return false;
  }
  const allowedOptions = normalizeReasoningOptions(reasoning.allowed_options);
  if (allowedOptions.length > 0) {
    return allowedOptions.some((option) => option !== "off");
  }
  const defaultOption = normalizeOptionalLowercaseString(reasoning.default);
  return defaultOption !== undefined && defaultOption !== "off";
}

export function resolveLoadedContextWindow(
  entry: Pick<LmstudioModelWire, "loaded_instances">,
): number | null {
  const loadedInstances = Array.isArray(entry.loaded_instances) ? entry.loaded_instances : [];
  let contextWindow: number | null = null;
  for (const instance of loadedInstances) {
    // Discovery payload is external JSON, so tolerate malformed entries.
    const normalized = asPositiveSafeInteger(instance?.config?.context_length);
    if (normalized === undefined) {
      continue;
    }
    contextWindow = contextWindow === null ? normalized : Math.max(contextWindow, normalized);
  }
  return contextWindow;
}

/**
 * Resolves LM Studio variant ids back to their loadable model key.
 *
 * LM Studio exposes quantized variants separately from the canonical `key`, but
 * `/api/v1/models/load` expects the key. Exact key matches still win so unusual
 * servers that expose a suffix as the real key are preserved.
 */
export function resolveLmstudioCanonicalModelKey(params: {
  modelKey: string;
  models: LmstudioModelWire[];
}): string {
  const modelKey = params.modelKey.trim();
  if (!modelKey) {
    return modelKey;
  }
  const normalizedModelKey = modelKey.toLowerCase();
  for (const entry of params.models) {
    if (entry.key?.trim() === modelKey) {
      return modelKey;
    }
  }
  for (const entry of params.models) {
    const key = entry.key?.trim();
    if (!key) {
      continue;
    }
    const selectedVariant =
      typeof entry.selected_variant === "string" ? entry.selected_variant.trim() : "";
    const variants = normalizeUniqueTrimmedStringList(entry.variants);
    if (
      selectedVariant.toLowerCase() === normalizedModelKey ||
      variants.some((variant) => variant.toLowerCase() === normalizedModelKey)
    ) {
      return key;
    }
  }
  return modelKey;
}

function normalizeUrlPath(pathname: string): string {
  return pathname
    .replace(/\/+$/, "")
    .replace(/\/api\/v1$/i, "")
    .replace(/\/v1$/i, "");
}

function isLikelyHostBaseUrl(value: string): boolean {
  return (
    /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+\.[a-z]{2,}|[^/\s?#]+:\d+)(?:[/?#].*)?$/i.test(
      value,
    ) && !value.startsWith("/")
  );
}

function normalizeConfiguredReasoningEffortMap(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = Object.fromEntries(
    Object.entries(value).flatMap(([key, mapped]) => {
      const normalizedKey = key.trim();
      const normalizedValue = mapped.trim();
      return normalizedKey && normalizedValue ? [[normalizedKey, normalizedValue] as const] : [];
    }),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeLmstudioConfiguredCompat(
  value: ModelDefinitionConfig["compat"],
): ModelDefinitionConfig["compat"] {
  if (!value) {
    return undefined;
  }
  const { supportedReasoningEfforts, reasoningEffortMap, ...compat } = value;
  const normalizedEfforts = normalizeReasoningOptions(supportedReasoningEfforts);
  const normalizedMap = normalizeConfiguredReasoningEffortMap(reasoningEffortMap);
  return normalizeLmstudioTransportReasoningCompat({
    ...compat,
    ...(normalizedEfforts.length > 0 ? { supportedReasoningEfforts: normalizedEfforts } : {}),
    ...(normalizedMap ? { reasoningEffortMap: normalizedMap } : {}),
  });
}

export function toFetchableLmstudioBaseUrl(value: string): string {
  if (/^https?:\/\//i.test(value) || !isLikelyHostBaseUrl(value)) {
    return value;
  }
  return `http://${value}`;
}

/** Resolves LM Studio server base URL (without /v1 or /api/v1). */
export function resolveLmstudioServerBase(configuredBaseUrl?: string): string {
  const configured = configuredBaseUrl?.trim();
  const resolved = configured || LMSTUDIO_DEFAULT_BASE_URL;
  const fetchableBaseUrl = toFetchableLmstudioBaseUrl(resolved);
  const parsed = URL.parse(fetchableBaseUrl);
  if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    const pathname = normalizeUrlPath(parsed.pathname);
    parsed.pathname = pathname.length > 0 ? pathname : "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  }
  const normalized = normalizeUrlPath(resolved.replace(/\/+$/, ""));
  return normalized.length > 0 ? normalized : LMSTUDIO_DEFAULT_BASE_URL;
}

export function resolveLmstudioInferenceBase(configuredBaseUrl?: string): string {
  const serverBase = resolveLmstudioServerBase(configuredBaseUrl);
  return `${serverBase}/v1`;
}

export function normalizeLmstudioProviderConfig(
  provider: ModelProviderConfig,
): ModelProviderConfig {
  const configuredBaseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
  if (!configuredBaseUrl) {
    return provider;
  }
  const normalizedBaseUrl = resolveLmstudioInferenceBase(configuredBaseUrl);
  const request =
    provider.request && typeof provider.request === "object" && !Array.isArray(provider.request)
      ? provider.request
      : undefined;
  const requestWithPrivateNetworkDefault =
    typeof request?.allowPrivateNetwork === "boolean"
      ? request
      : {
          ...request,
          allowPrivateNetwork: true,
        };
  if (
    normalizedBaseUrl === provider.baseUrl &&
    requestWithPrivateNetworkDefault === provider.request
  ) {
    return provider;
  }
  return {
    ...provider,
    baseUrl: normalizedBaseUrl,
    request: requestWithPrivateNetworkDefault,
  };
}

export function normalizeLmstudioConfiguredCatalogEntries(
  models: readonly ModelDefinitionConfig[] = [],
) {
  return models.flatMap((entry) => {
    const id = entry.id.trim();
    if (!id) {
      return [];
    }
    const parameterCount = asPositiveSafeInteger(entry.parameterCount);
    const input = entry.input?.filter((item) => item === "text" || item === "image");
    return [
      {
        provider: LMSTUDIO_PROVIDER_ID,
        id,
        name: entry.name?.trim() ? entry.name : id,
        ...(parameterCount !== undefined ? { parameterCount } : {}),
        contextWindow: asPositiveSafeInteger(entry.contextWindow),
        contextTokens: asPositiveSafeInteger(entry.contextTokens),
        reasoning: entry.reasoning,
        input: input && input.length > 0 ? input : undefined,
        compat: {
          ...normalizeLmstudioConfiguredCompat(entry.compat),
          supportsUsageInStreaming: true,
        },
      },
    ];
  });
}

export function buildLmstudioModelName(model: {
  displayName: string;
  format: "gguf" | "mlx" | null;
  vision: boolean;
  trainedForToolUse: boolean;
  loaded: boolean;
}): string {
  const tags: string[] = [];
  if (model.format === "mlx") {
    tags.push("MLX");
  } else if (model.format === "gguf") {
    tags.push("GGUF");
  }
  if (model.vision) {
    tags.push("vision");
  }
  if (model.trainedForToolUse) {
    tags.push("tool-use");
  }
  if (model.loaded) {
    tags.push("loaded");
  }
  if (tags.length === 0) {
    return model.displayName;
  }
  return `${model.displayName} (${tags.join(", ")})`;
}

/**
 * Shared by the setup layer (persists simple names to config) and the runtime
 * discovery path (which enriches the name with format/state tags).
 */
export type LmstudioModelBase = {
  id: string;
  displayName: string;
  format: "gguf" | "mlx" | null;
  vision: boolean;
  trainedForToolUse: boolean;
  loaded: boolean;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: ModelDefinitionConfig["cost"];
  compat?: ModelDefinitionConfig["compat"];
  contextWindow: number;
  contextTokens: number;
  maxTokens: number;
};

export function mapLmstudioWireEntry(entry: LmstudioModelWire): LmstudioModelBase | null {
  if (entry.type !== "llm") {
    return null;
  }
  const id = entry.key?.trim() ?? "";
  if (!id) {
    return null;
  }
  const loadedContextWindow = resolveLoadedContextWindow(entry);
  const advertisedContextWindow = asPositiveSafeInteger(entry.max_context_length) ?? null;
  const contextWindow = advertisedContextWindow ?? SELF_HOSTED_DEFAULT_CONTEXT_WINDOW;
  // ModelDefinitionConfig keeps the native maximum in contextWindow. Runtime
  // budgeting reads contextTokens, so it must reflect what the server actually
  // serves: a loaded instance is authoritative for its own context, while an
  // unloaded model is budgeted at the length JIT loading will request — the
  // same clamp ensureLmstudioModelLoaded applies when it triggers the load.
  const effectiveContextWindow = loadedContextWindow ?? contextWindow;
  const contextTokens =
    loadedContextWindow ?? Math.min(contextWindow, LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH);
  const rawDisplayName = entry.display_name?.trim();
  const reasoningCompat = resolveLmstudioReasoningCompat(entry);
  const trainedForToolUse = entry.capabilities?.trained_for_tool_use;
  // Native tool training is a positive capability, not proof that LM Studio's
  // OpenAI-compatible fallback cannot call tools.
  const compat =
    trainedForToolUse === true
      ? { ...reasoningCompat, supportsTools: trainedForToolUse }
      : reasoningCompat;
  return {
    id,
    displayName: rawDisplayName || id,
    format: entry.format ?? null,
    vision: entry.capabilities?.vision === true,
    trainedForToolUse: entry.capabilities?.trained_for_tool_use === true,
    // Use the same validity check as resolveLoadedContextWindow so malformed entries
    // like [null, {}] don't produce a false positive "loaded" tag.
    loaded: loadedContextWindow !== null,
    reasoning: resolveLmstudioReasoningCapability(entry),
    input: entry.capabilities?.vision ? ["text", "image"] : ["text"],
    cost: SELF_HOSTED_DEFAULT_COST,
    compat,
    contextWindow,
    contextTokens,
    maxTokens: Math.max(1, Math.min(effectiveContextWindow, SELF_HOSTED_DEFAULT_MAX_TOKENS)),
  };
}

export function mapLmstudioWireModelsToConfig(
  models: LmstudioModelWire[],
): ModelDefinitionConfig[] {
  return mapLmstudioWireModels(models, "config");
}

/** Config persistence keeps plain names; runtime discovery adds state tags and usage compat. */
export function mapLmstudioWireModels(
  models: LmstudioModelWire[],
  mode: "config" | "runtime",
): ModelDefinitionConfig[] {
  return models
    .map((entry): ModelDefinitionConfig | null => {
      const base = mapLmstudioWireEntry(entry);
      if (!base) {
        return null;
      }
      return {
        id: base.id,
        name: mode === "runtime" ? buildLmstudioModelName(base) : base.displayName,
        reasoning: base.reasoning,
        input: base.input,
        cost: base.cost,
        ...(mode === "runtime"
          ? { compat: { ...base.compat, supportsUsageInStreaming: true } }
          : base.compat
            ? { compat: base.compat }
            : {}),
        contextWindow: base.contextWindow,
        contextTokens: base.contextTokens,
        maxTokens: base.maxTokens,
      };
    })
    .filter((entry): entry is ModelDefinitionConfig => entry !== null);
}

export function normalizeLmstudioModelKey(modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed.toLowerCase().startsWith("lmstudio/")) {
    return trimmed.slice("lmstudio/".length).trim();
  }
  return trimmed;
}

export const getUnlistedLmstudioConfiguredModelIds: NonNullable<
  NonNullable<ProviderPlugin["catalog"]>["getUnlistedConfiguredModelIds"]
> = (catalog, configuredModels) => {
  const modelIds = new Set(catalog.modelIds);
  const aliases = new Set(catalog.aliases?.map((alias) => alias.toLowerCase()));
  return configuredModels
    .filter((model) => {
      if (
        model.provider !== "lmstudio" ||
        (model.baseUrl &&
          resolveLmstudioServerBase(model.baseUrl) !== resolveLmstudioServerBase(catalog.baseUrl))
      ) {
        return false;
      }
      const modelKey = normalizeLmstudioModelKey(model.modelId);
      return !modelIds.has(modelKey) && !aliases.has(modelKey.toLowerCase());
    })
    .map((model) => model.modelId);
};
