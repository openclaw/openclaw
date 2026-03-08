import { normalizeProviderId } from "./model-selection.js";

export type ProviderCapabilities = {
  anthropicToolSchemaMode: "native" | "openai-functions";
  anthropicToolChoiceMode: "native" | "openai-string-modes";
  preserveAnthropicThinkingSignatures: boolean;
  openAiCompatTurnValidation: boolean;
  geminiThoughtSignatureSanitization: boolean;
  transcriptToolCallIdMode: "default" | "strict9";
};

const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  anthropicToolSchemaMode: "native",
  anthropicToolChoiceMode: "native",
  preserveAnthropicThinkingSignatures: true,
  openAiCompatTurnValidation: true,
  geminiThoughtSignatureSanitization: false,
  transcriptToolCallIdMode: "default",
};

const PROVIDER_CAPABILITIES: Record<string, Partial<ProviderCapabilities>> = {
  "kimi-coding": {
    anthropicToolSchemaMode: "openai-functions",
    anthropicToolChoiceMode: "openai-string-modes",
    preserveAnthropicThinkingSignatures: false,
  },
  mistral: {
    transcriptToolCallIdMode: "strict9",
  },
  openrouter: {
    openAiCompatTurnValidation: false,
    geminiThoughtSignatureSanitization: true,
  },
  opencode: {
    openAiCompatTurnValidation: false,
    geminiThoughtSignatureSanitization: true,
  },
  kilocode: {
    geminiThoughtSignatureSanitization: true,
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

export function requiresOpenAiCompatibleAnthropicToolPayload(provider?: string | null): boolean {
  const capabilities = resolveProviderCapabilities(provider);
  return (
    capabilities.anthropicToolSchemaMode !== "native" ||
    capabilities.anthropicToolChoiceMode !== "native"
  );
}

export function usesOpenAiFunctionAnthropicToolSchema(provider?: string | null): boolean {
  return resolveProviderCapabilities(provider).anthropicToolSchemaMode === "openai-functions";
}

export function usesOpenAiStringModeAnthropicToolChoice(provider?: string | null): boolean {
  return resolveProviderCapabilities(provider).anthropicToolChoiceMode === "openai-string-modes";
}

export function supportsOpenAiCompatTurnValidation(provider?: string | null): boolean {
  return resolveProviderCapabilities(provider).openAiCompatTurnValidation;
}

export function sanitizesGeminiThoughtSignatures(provider?: string | null): boolean {
  return resolveProviderCapabilities(provider).geminiThoughtSignatureSanitization;
}

export function resolveTranscriptToolCallIdMode(provider?: string | null): "strict9" | undefined {
  const mode = resolveProviderCapabilities(provider).transcriptToolCallIdMode;
  return mode === "strict9" ? mode : undefined;
}
