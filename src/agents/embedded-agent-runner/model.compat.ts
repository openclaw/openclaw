import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelDataMediaInputConfig as ModelMediaInputConfig } from "../../../packages/llm-core/src/model-data.js";
import type { ModelCompatConfig } from "../../config/zod-schema.model-compat.js";
import { isVllmQwenThinkingCompat } from "../model-compat-catalog.js";

export function mergeModelMediaInput(
  base: ModelMediaInputConfig | undefined,
  override: ModelMediaInputConfig | undefined,
): ModelMediaInputConfig | undefined {
  if (!base || !override) {
    return base || override;
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
