import { normalizeLowercaseStringOrEmpty } from "./provider-id.js";
import {
  normalizeGooglePreviewModelId,
  normalizeTogetherModelId,
} from "./provider-model-id-normalize.js";

export type ManifestModelIdNormalizationProvider = {
  aliases?: Record<string, string>;
  stripPrefixes?: string[];
  prefixWhenBare?: string;
  prefixWhenBareAfterAliasStartsWith?: {
    modelPrefix: string;
    prefix: string;
  }[];
};

export type ManifestModelIdNormalizationRecord = {
  modelIdNormalization?: {
    providers?: Record<string, ManifestModelIdNormalizationProvider>;
  };
};

let currentManifestModelIdNormalizationPolicies:
  | ReadonlyMap<string, ManifestModelIdNormalizationProvider>
  | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModelIdNormalizationProviders(plugin: ManifestModelIdNormalizationRecord): unknown {
  try {
    return plugin.modelIdNormalization?.providers;
  } catch {
    return undefined;
  }
}

function readRecordEntries(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) {
    return [];
  }
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    try {
      entries.push([key, value[key]]);
    } catch {
      continue;
    }
  }
  return entries;
}

function readPolicyField<K extends keyof ManifestModelIdNormalizationProvider>(
  policy: ManifestModelIdNormalizationProvider,
  field: K,
): ManifestModelIdNormalizationProvider[K] | undefined {
  try {
    return policy[field];
  } catch {
    return undefined;
  }
}

function readArrayEntries(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  let length: number;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      if (!(index in value)) {
        continue;
      }
    } catch {
      continue;
    }
    try {
      entries.push(value[index]);
    } catch {
      continue;
    }
  }
  return entries;
}

function readStringMapValue(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = value[key];
  } catch {
    return undefined;
  }
  return typeof raw === "string" ? raw : undefined;
}

function readRecordStringField(value: unknown, field: string): string | undefined {
  return readStringMapValue(value, field);
}

export function collectManifestModelIdNormalizationPolicies(
  plugins: readonly ManifestModelIdNormalizationRecord[],
): Map<string, ManifestModelIdNormalizationProvider> {
  const policies = new Map<string, ManifestModelIdNormalizationProvider>();
  for (const plugin of plugins) {
    for (const [provider, policy] of readRecordEntries(readModelIdNormalizationProviders(plugin))) {
      if (isRecord(policy)) {
        policies.set(
          normalizeLowercaseStringOrEmpty(provider),
          policy as ManifestModelIdNormalizationProvider,
        );
      }
    }
  }
  return policies;
}

export function setCurrentManifestModelIdNormalizationRecords(
  plugins: readonly ManifestModelIdNormalizationRecord[] | undefined,
): void {
  currentManifestModelIdNormalizationPolicies = plugins
    ? collectManifestModelIdNormalizationPolicies(plugins)
    : undefined;
}

export function getCurrentManifestModelIdNormalizationPolicies():
  | ReadonlyMap<string, ManifestModelIdNormalizationProvider>
  | undefined {
  return currentManifestModelIdNormalizationPolicies;
}

function hasProviderPrefix(modelId: string): boolean {
  return modelId.includes("/");
}

function formatPrefixedModelId(prefix: string, modelId: string): string {
  return `${prefix.replace(/\/+$/u, "")}/${modelId.replace(/^\/+/u, "")}`;
}

export function stripSelfProviderModelPrefix(provider: string, model: string): string {
  const prefix = `${normalizeLowercaseStringOrEmpty(provider)}/`;
  const trimmed = model.trim();
  return normalizeLowercaseStringOrEmpty(trimmed).startsWith(prefix)
    ? trimmed.slice(prefix.length)
    : model;
}

export function normalizeProviderModelIdWithPolicies(params: {
  provider: string;
  policies: ReadonlyMap<string, ManifestModelIdNormalizationProvider>;
  context: {
    modelId: string;
  };
}): string | undefined {
  const policy = params.policies.get(normalizeLowercaseStringOrEmpty(params.provider));
  if (!policy) {
    return undefined;
  }

  let modelId = params.context.modelId.trim();
  if (!modelId) {
    return modelId;
  }

  for (const prefix of readArrayEntries(readPolicyField(policy, "stripPrefixes"))) {
    const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
    if (
      typeof prefix === "string" &&
      normalizedPrefix &&
      normalizeLowercaseStringOrEmpty(modelId).startsWith(normalizedPrefix)
    ) {
      modelId = modelId.slice(prefix.length);
      break;
    }
  }

  modelId =
    readStringMapValue(
      readPolicyField(policy, "aliases"),
      normalizeLowercaseStringOrEmpty(modelId),
    ) ?? modelId;

  if (!hasProviderPrefix(modelId)) {
    for (const rule of readArrayEntries(
      readPolicyField(policy, "prefixWhenBareAfterAliasStartsWith"),
    )) {
      const modelPrefix = readRecordStringField(rule, "modelPrefix");
      const prefix = readRecordStringField(rule, "prefix");
      if (
        modelPrefix &&
        prefix &&
        normalizeLowercaseStringOrEmpty(modelId).startsWith(modelPrefix.toLowerCase())
      ) {
        return formatPrefixedModelId(prefix, modelId);
      }
    }
    const prefixWhenBare = readPolicyField(policy, "prefixWhenBare");
    if (typeof prefixWhenBare === "string" && prefixWhenBare) {
      return formatPrefixedModelId(prefixWhenBare, modelId);
    }
  }

  return modelId;
}

export function normalizeBuiltInProviderModelId(provider: string, model: string): string {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  if (
    normalizedProvider === "google" ||
    normalizedProvider === "google-gemini-cli" ||
    normalizedProvider === "google-vertex"
  ) {
    return normalizeGooglePreviewModelId(model);
  }
  if (normalizedProvider === "openrouter") {
    const trimmed = model.trim();
    return trimmed && !trimmed.includes("/") ? `openrouter/${trimmed}` : model;
  }
  if (normalizedProvider === "anthropic") {
    const anthropicAliases: Record<string, string> = {
      "opus-4.8": "claude-opus-4-8",
      opus: "claude-opus-4-8",
      "opus-4.6": "claude-opus-4-6",
      "sonnet-4.6": "claude-sonnet-4-6",
    };
    const anthropicPrefix = "anthropic/";
    const normalizedModel = normalizeLowercaseStringOrEmpty(model);
    const providerModel = normalizedModel.startsWith(anthropicPrefix)
      ? model.trim().slice(anthropicPrefix.length)
      : model;
    return anthropicAliases[normalizeLowercaseStringOrEmpty(providerModel)] ?? providerModel;
  }
  if (normalizedProvider === "vercel-ai-gateway") {
    const vercelAliases: Record<string, string> = {
      "opus-4.6": "claude-opus-4-6",
      "sonnet-4.6": "claude-sonnet-4-6",
    };
    const aliased = vercelAliases[normalizeLowercaseStringOrEmpty(model)] ?? model;
    return normalizeLowercaseStringOrEmpty(aliased).startsWith("claude-")
      ? `anthropic/${aliased}`
      : aliased;
  }
  if (normalizedProvider === "huggingface") {
    const prefix = "huggingface/";
    return normalizeLowercaseStringOrEmpty(model).startsWith(prefix)
      ? model.slice(prefix.length)
      : model;
  }
  if (normalizedProvider === "nvidia") {
    const trimmed = model.trim();
    return trimmed && !trimmed.includes("/") ? `nvidia/${trimmed}` : model;
  }
  if (normalizedProvider === "xai") {
    const xaiAliases: Record<string, string> = {
      "grok-4-fast-reasoning": "grok-4-fast",
      "grok-4-1-fast-reasoning": "grok-4-1-fast",
      "grok-4.20-experimental-beta-0304-reasoning": "grok-4.20-beta-latest-reasoning",
      "grok-4.20-experimental-beta-0304-non-reasoning": "grok-4.20-beta-latest-non-reasoning",
      "grok-4.20-reasoning": "grok-4.20-beta-latest-reasoning",
      "grok-4.20-non-reasoning": "grok-4.20-beta-latest-non-reasoning",
    };
    return xaiAliases[normalizeLowercaseStringOrEmpty(model)] ?? model;
  }
  if (normalizedProvider === "openai") {
    return model;
  }
  if (normalizedProvider === "together") {
    return normalizeTogetherModelId(model);
  }
  return model;
}

export function normalizeStaticProviderModelIdWithPolicies(
  provider: string,
  model: string,
  policies?: ReadonlyMap<string, ManifestModelIdNormalizationProvider>,
): string {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  const manifestModelId = policies
    ? (normalizeProviderModelIdWithPolicies({
        provider: normalizedProvider,
        policies,
        context: {
          modelId: model,
        },
      }) ?? model)
    : model;
  return normalizeBuiltInProviderModelId(normalizedProvider, manifestModelId);
}

export function normalizeConfiguredProviderCatalogModelId(
  provider: string,
  model: string,
  policies = getCurrentManifestModelIdNormalizationPolicies(),
): string {
  const providerModel = normalizeStaticProviderModelIdWithPolicies(provider, model, policies);
  return normalizeConfiguredProviderCatalogModelRef(providerModel);
}

export function normalizeConfiguredProviderCatalogModelRef(providerModel: string): string {
  const googlePrefix = "google/";
  if (!providerModel.startsWith(googlePrefix)) {
    const slash = providerModel.indexOf("/");
    if (slash <= 0 || slash >= providerModel.length - 1) {
      return providerModel;
    }
    const prefix = providerModel.slice(0, slash + 1);
    const suffix = providerModel.slice(slash + 1);
    if (!suffix.startsWith(googlePrefix)) {
      return providerModel;
    }
    const normalizedSuffix = normalizeGooglePreviewModelId(suffix);
    return normalizedSuffix === suffix ? providerModel : `${prefix}${normalizedSuffix}`;
  }
  const modelId = providerModel.slice(googlePrefix.length);
  const normalizedModelId = normalizeGooglePreviewModelId(modelId);
  return normalizedModelId === modelId ? providerModel : `${googlePrefix}${normalizedModelId}`;
}
