import {
  normalizeGooglePreviewModelId,
  normalizeTogetherModelId,
} from "../plugin-sdk/provider-model-id-normalize.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginManifestModelIdNormalizationProvider } from "../plugins/manifest.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./provider-id.js";

type StaticModelRef = {
  provider: string;
  model: string;
};

export type ProviderModelIdNormalizationOptions = {
  allowManifestNormalization?: boolean;
  manifestPlugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};

function collectManifestModelIdNormalizationPolicies(
  plugins: readonly Pick<PluginManifestRecord, "modelIdNormalization">[],
): Map<string, PluginManifestModelIdNormalizationProvider> {
  const policies = new Map<string, PluginManifestModelIdNormalizationProvider>();
  for (const plugin of plugins) {
    for (const [provider, policy] of Object.entries(plugin.modelIdNormalization?.providers ?? {})) {
      policies.set(normalizeLowercaseStringOrEmpty(provider), policy);
    }
  }
  return policies;
}

function hasProviderPrefix(modelId: string): boolean {
  return modelId.includes("/");
}

function formatPrefixedModelId(prefix: string, modelId: string): string {
  return `${prefix.replace(/\/+$/u, "")}/${modelId.replace(/^\/+/u, "")}`;
}

function normalizeProviderModelIdWithManifestPlugins(params: {
  provider: string;
  plugins: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
  modelId: string;
}): string | undefined {
  const policy = collectManifestModelIdNormalizationPolicies(params.plugins).get(
    normalizeLowercaseStringOrEmpty(params.provider),
  );
  if (!policy) {
    return undefined;
  }

  let modelId = params.modelId.trim();
  if (!modelId) {
    return modelId;
  }

  for (const prefix of policy.stripPrefixes ?? []) {
    const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
    if (normalizedPrefix && normalizeLowercaseStringOrEmpty(modelId).startsWith(normalizedPrefix)) {
      modelId = modelId.slice(prefix.length);
      break;
    }
  }

  modelId = policy.aliases?.[normalizeLowercaseStringOrEmpty(modelId)] ?? modelId;

  if (!hasProviderPrefix(modelId)) {
    for (const rule of policy.prefixWhenBareAfterAliasStartsWith ?? []) {
      if (normalizeLowercaseStringOrEmpty(modelId).startsWith(rule.modelPrefix.toLowerCase())) {
        return formatPrefixedModelId(rule.prefix, modelId);
      }
    }
    if (policy.prefixWhenBare) {
      return formatPrefixedModelId(policy.prefixWhenBare, modelId);
    }
  }

  return modelId;
}

function resolveManifestNormalizationPlugins(
  options: ProviderModelIdNormalizationOptions,
): readonly Pick<PluginManifestRecord, "modelIdNormalization">[] | undefined {
  if (options.manifestPlugins) {
    return options.manifestPlugins;
  }
  return (
    getCurrentPluginMetadataSnapshot({
      allowWorkspaceScopedSnapshot: true,
      requireDefaultDiscoveryContext: true,
    })?.plugins ??
    resolvePluginMetadataSnapshot({ config: {}, allowWorkspaceScopedCurrent: true }).plugins
  );
}

export function modelKey(provider: string, model: string): string {
  const providerId = provider.trim();
  const modelId = model.trim();
  if (!providerId) {
    return modelId;
  }
  if (!modelId) {
    return providerId;
  }
  return normalizeLowercaseStringOrEmpty(modelId).startsWith(
    `${normalizeLowercaseStringOrEmpty(providerId)}/`,
  )
    ? modelId
    : `${providerId}/${modelId}`;
}

export function normalizeStaticProviderModelId(
  provider: string,
  model: string,
  options: ProviderModelIdNormalizationOptions = {},
): string {
  const normalizedProvider = normalizeProviderId(provider);
  if (options.allowManifestNormalization === false) {
    return normalizeBuiltInProviderModelId(normalizedProvider, model);
  }
  const manifestPlugins = resolveManifestNormalizationPlugins(options);
  const manifestModelId = manifestPlugins
    ? normalizeProviderModelIdWithManifestPlugins({
        provider: normalizedProvider,
        plugins: manifestPlugins,
        modelId: model,
      })
    : undefined;
  return normalizeBuiltInProviderModelId(normalizedProvider, manifestModelId ?? model);
}

function normalizeBuiltInProviderModelId(provider: string, model: string): string {
  if (provider === "google" || provider === "google-gemini-cli" || provider === "google-vertex") {
    return normalizeGooglePreviewModelId(model);
  }
  if (provider === "openrouter") {
    const trimmed = model.trim();
    return trimmed && !trimmed.includes("/") ? `openrouter/${trimmed}` : model;
  }
  if (provider === "nvidia") {
    const trimmed = model.trim();
    return trimmed && !trimmed.includes("/") ? `nvidia/${trimmed}` : model;
  }
  if (provider === "xai") {
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
  if (provider === "together") {
    return normalizeTogetherModelId(model);
  }
  return model;
}

export function normalizeConfiguredProviderCatalogModelId(
  provider: string,
  model: string,
  options: ProviderModelIdNormalizationOptions = {},
): string {
  const providerModel = normalizeStaticProviderModelId(provider, model, options);
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

function parseStaticModelRef(raw: string, defaultProvider: string): StaticModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  const providerRaw = slash === -1 ? defaultProvider : trimmed.slice(0, slash).trim();
  const modelRaw = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
  if (!providerRaw || !modelRaw) {
    return null;
  }
  const provider = normalizeProviderId(providerRaw);
  return {
    provider,
    model: normalizeStaticProviderModelId(provider, modelRaw),
  };
}

export function resolveStaticAllowlistModelKey(
  raw: string,
  defaultProvider: string,
): string | null {
  const parsed = parseStaticModelRef(raw, defaultProvider);
  if (!parsed) {
    return null;
  }
  return modelKey(parsed.provider, parsed.model);
}

export function formatLiteralProviderPrefixedModelRef(provider: string, modelRef: string): string {
  const providerId = normalizeProviderId(provider);
  const trimmedRef = modelRef.trim();
  if (!providerId || !trimmedRef) {
    return trimmedRef;
  }
  const normalizedRef = normalizeLowercaseStringOrEmpty(trimmedRef);
  const literalPrefix = `${providerId}/${providerId}/`;
  if (normalizedRef.startsWith(literalPrefix)) {
    return trimmedRef;
  }
  return normalizedRef.startsWith(`${providerId}/`) ? `${providerId}/${trimmedRef}` : trimmedRef;
}
