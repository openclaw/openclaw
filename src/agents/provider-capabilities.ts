import { normalizeProviderId } from "./model-selection.js";

export type ProviderCapabilities = {
  anthropicToolSchemaMode: "native" | "openai-functions";
  anthropicToolChoiceMode: "native" | "openai-string-modes";
  preserveAnthropicThinkingSignatures: boolean;
};

const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  anthropicToolSchemaMode: "native",
  anthropicToolChoiceMode: "native",
  preserveAnthropicThinkingSignatures: true,
};

const PROVIDER_CAPABILITIES: Record<string, Partial<ProviderCapabilities>> = {
  "kimi-coding": {
    anthropicToolSchemaMode: "openai-functions",
    anthropicToolChoiceMode: "openai-string-modes",
    preserveAnthropicThinkingSignatures: false,
  },
};

export function resolveProviderCapabilities(provider?: string | null): ProviderCapabilities {
  const normalized = normalizeProviderId(provider ?? "");
  return {
    ...DEFAULT_PROVIDER_CAPABILITIES,
    ...PROVIDER_CAPABILITIES[normalized],
  };
}

export function preservesAnthropicThinkingSignatures(provider?: string | null): boolean {
  return resolveProviderCapabilities(provider).preserveAnthropicThinkingSignatures;
}

export function usesOpenAiFunctionAnthropicToolSchema(provider?: string | null): boolean {
  return resolveProviderCapabilities(provider).anthropicToolSchemaMode === "openai-functions";
}

export function usesOpenAiStringModeAnthropicToolChoice(provider?: string | null): boolean {
  return resolveProviderCapabilities(provider).anthropicToolChoiceMode === "openai-string-modes";
}
