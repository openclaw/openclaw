import type { ModelCompatConfig, ModelMediaInputConfig } from "../../config/types.models.js";
import { isVllmQwenThinkingCompat } from "../model-compat-catalog.js";
import { normalizeProviderId } from "../model-selection.js";

export function mergeModelMediaInput(
  base: ModelMediaInputConfig | undefined,
  override: ModelMediaInputConfig | undefined,
): ModelMediaInputConfig | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
    image:
      base.image || override.image
        ? {
            ...base.image,
            ...override.image,
          }
        : undefined,
  };
}

export function resolveMergedConfiguredModelReasoning(params: {
  provider: string;
  compat?: ModelCompatConfig;
  configuredReasoning?: boolean;
  discoveredReasoning?: boolean;
}): boolean {
  return (
    params.configuredReasoning ??
    (isVllmQwenThinkingCompat(normalizeProviderId(params.provider), params.compat) ||
      (params.discoveredReasoning ?? false))
  );
}
