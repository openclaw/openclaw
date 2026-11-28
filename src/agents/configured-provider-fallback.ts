/**
 * Chooses a configured provider/model row when the user's model config names
 * no primary.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.js";
import type { ModelRef } from "./model-ref-shared.js";

/** Resolve the first configured provider/model that can stand in for a missing primary. */
export function resolveConfiguredProviderFallback(params: {
  cfg: Pick<OpenClawConfig, "models">;
  excludedModel?: ModelRef;
}): ModelRef | null {
  const configuredProviders = params.cfg.models?.providers;
  if (!configuredProviders || typeof configuredProviders !== "object") {
    return null;
  }
  // A utility-only row does not express primary intent. Keep the remaining
  // provider/model insertion order as the operator's fallback preference.
  for (const [provider, providerCfg] of Object.entries(configuredProviders)) {
    const models = providerCfg?.models;
    if (!models?.[0]?.id) {
      continue;
    }
    const normalizedProvider = normalizeProviderId(provider);
    const model = models.find(
      (entry) =>
        entry?.id &&
        (normalizedProvider !== params.excludedModel?.provider ||
          entry.id !== params.excludedModel.model),
    );
    if (model) {
      return { provider: normalizedProvider, model: model.id };
    }
  }
  return null;
}
