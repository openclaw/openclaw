import type { ModelCompatConfig, ModelMediaInputConfig } from "../../config/types.models.js";
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

export function resolveConfiguredFallbackReasoning(params: {
  provider: string;
  compat?: unknown;
  reasoning?: boolean;
}): boolean {
  return params.reasoning ?? isVllmQwenThinkingCompat(params);
}

export function resolveMergedConfiguredModelReasoning(params: {
  provider: string;
  compat?: unknown;
  configuredReasoning?: boolean;
  discoveredReasoning?: boolean;
}): boolean {
  if (params.configuredReasoning !== undefined) {
    return params.configuredReasoning;
  }
  return isVllmQwenThinkingCompat(params) || (params.discoveredReasoning ?? false);
}

function isVllmQwenThinkingCompat(params: { provider: string; compat?: unknown }): boolean {
  const { compat } = params;
  if (!compat || typeof compat !== "object" || Array.isArray(compat)) {
    return false;
  }
  const thinkingFormat = (compat as { thinkingFormat?: unknown }).thinkingFormat;
  return (
    normalizeProviderId(params.provider) === "vllm" &&
    (thinkingFormat === "qwen" || thinkingFormat === "qwen-chat-template")
  );
}

export function mergeModelCompat(
  base: ModelCompatConfig | undefined,
  override: ModelCompatConfig | undefined,
): ModelCompatConfig | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  return { ...base, ...override };
}
