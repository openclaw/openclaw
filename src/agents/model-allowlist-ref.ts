import { normalizeProviderId } from "./provider-id.js";

function normalizeAnthropicModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return trimmed;
  }
  switch (trimmed.toLowerCase()) {
    case "opus-4.6":
      return "claude-opus-4-6";
    case "opus-4.5":
      return "claude-opus-4-5";
    case "sonnet-4.6":
      return "claude-sonnet-4-6";
    case "sonnet-4.5":
      return "claude-sonnet-4-5";
    default:
      return trimmed;
  }
}

function normalizeStaticProviderModelId(provider: string, model: string): string {
  if (provider === "anthropic") {
    return normalizeAnthropicModelId(model);
  }
  if (provider === "vercel-ai-gateway" && !model.includes("/")) {
    const normalizedAnthropicModel = normalizeAnthropicModelId(model);
    if (normalizedAnthropicModel.startsWith("claude-")) {
      return `anthropic/${normalizedAnthropicModel}`;
    }
  }
  if (provider === "openrouter" && !model.includes("/")) {
    return `openrouter/${model}`;
  }
  return model;
}

function modelKey(provider: string, model: string): string {
  const providerId = provider.trim();
  const modelId = model.trim();
  if (!providerId) {
    return modelId;
  }
  if (!modelId) {
    return providerId;
  }
  return modelId.toLowerCase().startsWith(`${providerId.toLowerCase()}/`)
    ? modelId
    : `${providerId}/${modelId}`;
}

function parseStaticModelRef(
  raw: string,
  defaultProvider: string,
): { provider: string; model: string } | null {
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

export function resolveAllowlistModelKey(raw: string, defaultProvider: string): string | null {
  const parsed = parseStaticModelRef(raw, defaultProvider);
  if (!parsed) {
    return null;
  }
  return modelKey(parsed.provider, parsed.model);
}
