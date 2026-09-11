// Persisted model metadata normalization without loading the broader selection runtime.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelFallbackRouteResolution } from "./model-fallback.types.js";
import type { ModelRef } from "./model-ref-shared.js";
import { parseModelRef } from "./model-selection-normalize.js";

function normalizePersistedDefaultProvider(value: unknown): string {
  return normalizeOptionalString(value) ?? DEFAULT_PROVIDER;
}

export function resolvePersistedOverrideModelRef(params: {
  defaultProvider?: unknown;
  overrideProvider?: unknown;
  overrideModel?: unknown;
  routeResolution?: ModelFallbackRouteResolution;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
}): ModelRef | null {
  const defaultProvider = normalizePersistedDefaultProvider(params.defaultProvider);
  const overrideProvider = normalizeOptionalString(params.overrideProvider);
  const overrideModel = normalizeOptionalString(params.overrideModel);
  if (!overrideModel) {
    return null;
  }
  if (params.routeResolution === "resolved") {
    // The producer already selected this identity; parsing aliases again can select another model.
    return { provider: overrideProvider ?? defaultProvider, model: overrideModel };
  }
  const encodedOverride = overrideProvider ? `${overrideProvider}/${overrideModel}` : overrideModel;
  return (
    parseModelRef(encodedOverride, defaultProvider, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    }) ?? {
      provider: overrideProvider || defaultProvider,
      model: overrideModel,
    }
  );
}

export function normalizeStoredOverrideModel(params: {
  providerOverride?: unknown;
  modelOverride?: unknown;
  routeResolution?: ModelFallbackRouteResolution;
}): { providerOverride?: string; modelOverride?: string } {
  const providerOverride = normalizeOptionalString(params.providerOverride);
  const modelOverride = normalizeOptionalString(params.modelOverride);
  if (!providerOverride || !modelOverride || params.routeResolution === "resolved") {
    return {
      providerOverride,
      modelOverride,
    };
  }

  const providerPrefix = `${providerOverride.toLowerCase()}/`;
  return {
    providerOverride,
    modelOverride: modelOverride.toLowerCase().startsWith(providerPrefix)
      ? modelOverride.slice(providerOverride.length + 1).trim() || modelOverride
      : modelOverride,
  };
}
