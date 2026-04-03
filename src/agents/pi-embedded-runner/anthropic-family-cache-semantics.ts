type AnthropicCacheRetentionFamily =
  | "anthropic-direct"
  | "anthropic-bedrock"
  | "custom-anthropic-api";

export function isAnthropicModelRef(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("anthropic/");
}

export function isAnthropicBedrockModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return normalized.includes("anthropic.claude") || normalized.includes("anthropic/claude");
}

export function isOpenRouterAnthropicModelRef(provider: string, modelId: string): boolean {
  return provider.trim().toLowerCase() === "openrouter" && isAnthropicModelRef(modelId);
}

export function resolveAnthropicCacheRetentionFamily(params: {
  provider: string;
  modelApi?: string;
  modelId?: string;
  hasExplicitCacheConfig: boolean;
}): AnthropicCacheRetentionFamily | undefined {
  const normalizedProvider = params.provider.trim().toLowerCase();
  if (normalizedProvider === "anthropic") {
    return "anthropic-direct";
  }
  if (
    normalizedProvider === "amazon-bedrock" &&
    params.hasExplicitCacheConfig &&
    typeof params.modelId === "string" &&
    isAnthropicBedrockModel(params.modelId)
  ) {
    return "anthropic-bedrock";
  }
  if (
    normalizedProvider !== "anthropic" &&
    normalizedProvider !== "amazon-bedrock" &&
    params.hasExplicitCacheConfig &&
    params.modelApi === "anthropic-messages"
  ) {
    return "custom-anthropic-api";
  }
  return undefined;
}
