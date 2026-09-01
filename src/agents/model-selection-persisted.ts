// Persisted model metadata normalization without loading the broader selection runtime.
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasExactConfiguredProviderModel } from "./configured-provider-model.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { type ModelRef, normalizeConfiguredProviderCatalogModelId } from "./model-ref-shared.js";
import { parseModelRef } from "./model-selection-normalize.js";

function normalizePersistedDefaultProvider(value: unknown): string {
  return normalizeOptionalString(value) ?? DEFAULT_PROVIDER;
}

export function resolvePersistedOverrideModelRef(params: {
  cfg?: OpenClawConfig;
  defaultProvider?: unknown;
  overrideProvider?: unknown;
  overrideModel?: unknown;
  routeResolution?: "raw" | "resolved";
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
}): ModelRef | null {
  const defaultProvider = normalizePersistedDefaultProvider(params.defaultProvider);
  const overrideProvider = normalizeOptionalString(params.overrideProvider);
  const overrideModel = normalizeOptionalString(params.overrideModel);
  if (!overrideModel) {
    return null;
  }
  // The writer already normalized a resolved pair. Replaying either static
  // policy or a runtime hook can change the selected model after persistence.
  if (overrideProvider && params.routeResolution === "resolved") {
    return { provider: overrideProvider, model: overrideModel };
  }
  const encodedOverride = overrideProvider ? `${overrideProvider}/${overrideModel}` : overrideModel;
  const raw = parseModelCatalogRef(encodedOverride) ?? {
    provider: defaultProvider,
    modelId: overrideModel,
  };
  if (
    hasExactConfiguredProviderModel({ cfg: params.cfg, provider: raw.provider, model: raw.modelId })
  ) {
    return {
      provider: raw.provider,
      model: normalizeConfiguredProviderCatalogModelId(raw.provider, raw.modelId, params),
    };
  }
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
