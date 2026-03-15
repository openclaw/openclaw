import { normalizeProviderId } from "./model-selection.js";

export type ProviderCapabilities = {
  anthropicToolSchemaMode: "native" | "openai-functions";
  anthropicToolChoiceMode: "native" | "openai-string-modes";
  providerFamily: "default" | "openai" | "anthropic";
  preserveAnthropicThinkingSignatures: boolean;
  openAiCompatTurnValidation: boolean;
  geminiThoughtSignatureSanitization: boolean;
  transcriptToolCallIdMode: "default" | "strict9";
  transcriptToolCallIdModelHints: string[];
  geminiThoughtSignatureModelHints: string[];
  dropThinkingBlockModelHints: string[];
  // Some aggregators (e.g. Straico) crash on `content: null` in assistant messages that
  // have tool_calls. Set true to replace null content with "" in outbound payloads.
  requiresNonNullAssistantContent: boolean;
  // Provider returns plain JSON instead of SSE even when stream: true is sent.
  // Use a non-streaming fetch wrapper instead of the OpenAI SDK streaming path.
  nonStreaming: boolean;
};

const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  anthropicToolSchemaMode: "native",
  anthropicToolChoiceMode: "native",
  providerFamily: "default",
  preserveAnthropicThinkingSignatures: true,
  openAiCompatTurnValidation: true,
  geminiThoughtSignatureSanitization: false,
  transcriptToolCallIdMode: "default",
  transcriptToolCallIdModelHints: [],
  geminiThoughtSignatureModelHints: [],
  dropThinkingBlockModelHints: [],
  requiresNonNullAssistantContent: false,
  nonStreaming: false,
};

const PROVIDER_CAPABILITIES: Record<string, Partial<ProviderCapabilities>> = {
  anthropic: {
    providerFamily: "anthropic",
  },
  "amazon-bedrock": {
    providerFamily: "anthropic",
  },
  "kimi-coding": {
    anthropicToolSchemaMode: "openai-functions",
    anthropicToolChoiceMode: "openai-string-modes",
    preserveAnthropicThinkingSignatures: false,
  },
  mistral: {
    transcriptToolCallIdMode: "strict9",
    transcriptToolCallIdModelHints: [
      "mistral",
      "mixtral",
      "codestral",
      "pixtral",
      "devstral",
      "ministral",
      "mistralai",
    ],
  },
  openai: {
    providerFamily: "openai",
  },
  "openai-codex": {
    providerFamily: "openai",
  },
  openrouter: {
    openAiCompatTurnValidation: false,
    geminiThoughtSignatureSanitization: true,
    geminiThoughtSignatureModelHints: ["gemini"],
  },
  opencode: {
    openAiCompatTurnValidation: false,
    geminiThoughtSignatureSanitization: true,
    geminiThoughtSignatureModelHints: ["gemini"],
  },
  kilocode: {
    geminiThoughtSignatureSanitization: true,
    geminiThoughtSignatureModelHints: ["gemini"],
  },
  "github-copilot": {
    dropThinkingBlockModelHints: ["claude"],
  },
  // Straico is an aggregator API (openai-completions). It does not support `thinking` content
  // blocks in conversation history (returns a silent empty response). Drop them for all models
  // (all Straico model IDs contain "/" e.g. "anthropic/claude-sonnet-4.5").
  // It also crashes (500) on assistant messages with content: null + tool_calls (e.g. tool-call
  // turns from GLM-5 where thinking is stripped, leaving only tool_calls with no text).
  straico: {
    openAiCompatTurnValidation: false,
    dropThinkingBlockModelHints: ["/"],
    requiresNonNullAssistantContent: true,
    nonStreaming: true,
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

export function requiresNonNullAssistantContentForProvider(provider?: string | null): boolean {
  return resolveProviderCapabilities(provider).requiresNonNullAssistantContent;
}

export function isNonStreamingProvider(provider?: string | null): boolean {
  return resolveProviderCapabilities(provider).nonStreaming;
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
): "strict9" | undefined {
  const capabilities = resolveProviderCapabilities(provider);
  const mode = capabilities.transcriptToolCallIdMode;
  if (mode === "strict9") {
    return mode;
  }
  if (modelIncludesAnyHint(modelId, capabilities.transcriptToolCallIdModelHints)) {
    return "strict9";
  }
  return undefined;
}
