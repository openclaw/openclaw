import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";

// Defaults for agent metadata when upstream does not supply them.
// Keep this aligned with the product-level latest-model baseline.
export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_MODEL = "gpt-6-astra";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;

/** Builds structural model metadata for a harness that resolves its real model natively. */
export function createNativeModelOwnedRuntimeModel(params: {
  provider: string;
  modelId: string;
}): ProviderRuntimeModel {
  return {
    provider: params.provider,
    id: params.modelId,
    name: params.modelId,
    baseUrl: "",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
  };
}
