import { resolveProviderCapabilitiesWithPlugin } from "../plugins/provider-runtime.js";
import { normalizeProviderId } from "./model-selection.js";
import type { ToolCallIdMode } from "./tool-call-id.js";

type ProviderTranscriptToolCallIdMode = ToolCallIdMode | "default" | undefined;

export type ProviderCapabilities = {
  anthropicToolSchemaMode: "native" | "openai-functions";
  anthropicToolChoiceMode: "native" | "openai-string-modes";
  providerFamily: "default" | "openai" | "anthropic";
  preserveAnthropicThinkingSignatures: boolean;
  openAiCompatTurnValidation: boolean;
  geminiThoughtSignatureSanitization: boolean;
  transcriptToolCallIdMode: ProviderTranscriptToolCallIdMode;
  transcriptToolCallIdModelHints: string[];
  geminiThoughtSignatureModelHints: string[];
  dropThinkingBlockModelHints: string[];
};

const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  anthropicToolSchemaMode: "native",
  anthropicToolChoiceMode: "native",
  providerFamily: "default",
  preserveAnthropicThinkingSignatures: true,
  openAiCompatTurnValidation: true,
  geminiThoughtSignatureSanitization: false,
  transcriptToolCallIdMode: undefined,
  transcriptToolCallIdModelHints: [],
  geminiThoughtSignatureModelHints: [],
  dropThinkingBlockModelHints: [],
};

const CORE_PROVIDER_CAPABILITIES: Record<string, Partial<ProviderCapabilities>> = {
  "amazon-bedrock": {
    providerFamily: "anthropic",
    transcriptToolCallIdMode: "default",
    dropThinkingBlockModelHints: ["claude"],
  },
};

const MISTRAL_TOOL_CALL_ID_HINTS = [
  "mistral",
  "mixtral",
  "codestral",
  "pixtral",
  "devstral",
  "ministral",
  "mistralai",
];

const PLUGIN_CAPABILITIES_FALLBACKS: Record<string, Partial<ProviderCapabilities>> = {
  anthropic: {
    providerFamily: "anthropic",
    dropThinkingBlockModelHints: ["claude"],
  },
  "github-copilot": {
    dropThinkingBlockModelHints: ["claude"],
  },
  kilocode: {
    geminiThoughtSignatureSanitization: true,
    geminiThoughtSignatureModelHints: ["gemini"],
  },
  "kimi-coding": {
    preserveAnthropicThinkingSignatures: false,
  },
  mistral: {
    transcriptToolCallIdMode: "strict9",
    transcriptToolCallIdModelHints: MISTRAL_TOOL_CALL_ID_HINTS,
  },
  opencode: {
    openAiCompatTurnValidation: false,
    geminiThoughtSignatureSanitization: true,
    geminiThoughtSignatureModelHints: ["gemini"],
  },
  "opencode-go": {
    openAiCompatTurnValidation: false,
    geminiThoughtSignatureSanitization: true,
    geminiThoughtSignatureModelHints: ["gemini"],
  },
  openai: {
    providerFamily: "openai",
  },
  "openai-codex": {
    providerFamily: "openai",
  },
  openrouter: {
    providerFamily: "openai",
    openAiCompatTurnValidation: false,
    geminiThoughtSignatureSanitization: true,
    geminiThoughtSignatureModelHints: ["gemini"],
    transcriptToolCallIdModelHints: MISTRAL_TOOL_CALL_ID_HINTS,
  },
};

export function resolveProviderCapabilities(provider?: string | null): ProviderCapabilities {
  const normalized = normalizeProviderId(provider ?? "");
  const pluginCapabilities = normalized
    ? resolveProviderCapabilitiesWithPlugin({ provider: normalized })
    : undefined;
  return {
    ...DEFAULT_PROVIDER_CAPABILITIES,
    ...CORE_PROVIDER_CAPABILITIES[normalized],
    ...PLUGIN_CAPABILITIES_FALLBACKS[normalized],
    ...pluginCapabilities,
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

function modelIncludesAnyHint(modelId: string | null | undefined, hints: string[]): boolean {
  const normalized = (modelId ?? "").toLowerCase();
  return Boolean(normalized) && hints.some((hint) => normalized.includes(hint));
}

export function isOpenAiProviderFamily(provider?: string | null): boolean {
  return resolveProviderCapabilities(provider).providerFamily === "openai";
}

export function isAnthropicProviderFamily(provider?: string | null): boolean {
  return resolveProviderCapabilities(provider).providerFamily === "anthropic";
}

export function shouldDropThinkingBlocksForModel(params: {
  provider?: string | null;
  modelId?: string | null;
}): boolean {
  return modelIncludesAnyHint(
    params.modelId,
    resolveProviderCapabilities(params.provider).dropThinkingBlockModelHints,
  );
}

export function shouldSanitizeGeminiThoughtSignaturesForModel(params: {
  provider?: string | null;
  modelId?: string | null;
}): boolean {
  const capabilities = resolveProviderCapabilities(params.provider);
  return (
    capabilities.geminiThoughtSignatureSanitization &&
    modelIncludesAnyHint(params.modelId, capabilities.geminiThoughtSignatureModelHints)
  );
}

export function resolveTranscriptToolCallIdMode(
  provider?: string | null,
  modelId?: string | null,
): ToolCallIdMode | undefined {
  const capabilities = resolveProviderCapabilities(provider);
  if (capabilities.transcriptToolCallIdMode === "strict9") {
    return "strict9";
  }
  if (modelIncludesAnyHint(modelId, capabilities.transcriptToolCallIdModelHints)) {
    return "strict9";
  }
  return undefined;
}
