import type { OpenClawConfig } from "../config/config.js";
import { resolveProviderCapabilitiesWithPlugin as resolveProviderCapabilitiesWithPluginRuntime } from "../plugins/provider-runtime.js";
import { normalizeProviderId } from "./model-selection.js";

export type ProviderCapabilities = {
  anthropicToolSchemaMode: "native" | "openai-functions";
  anthropicToolChoiceMode: "native" | "openai-string-modes";
  openAiPayloadNormalizationMode: "default" | "moonshot-thinking";
  providerFamily: "default" | "openai" | "anthropic";
  preserveAnthropicThinkingSignatures: boolean;
  openAiCompatTurnValidation: boolean;
  geminiThoughtSignatureSanitization: boolean;
  transcriptToolCallIdMode: "default" | "strict9";
  transcriptToolCallIdModelHints: string[];
  geminiThoughtSignatureModelHints: string[];
  dropThinkingBlockModelHints: string[];
};

export type ProviderCapabilityLookupOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  anthropicToolSchemaMode: "native",
  anthropicToolChoiceMode: "native",
  openAiPayloadNormalizationMode: "default",
  providerFamily: "default",
  preserveAnthropicThinkingSignatures: true,
  openAiCompatTurnValidation: true,
  geminiThoughtSignatureSanitization: false,
  transcriptToolCallIdMode: "default",
  transcriptToolCallIdModelHints: [],
  geminiThoughtSignatureModelHints: [],
  dropThinkingBlockModelHints: [],
};

const CORE_PROVIDER_CAPABILITIES: Record<string, Partial<ProviderCapabilities>> = {
  "anthropic-vertex": {
    providerFamily: "anthropic",
    dropThinkingBlockModelHints: ["claude"],
  },
  "amazon-bedrock": {
    providerFamily: "anthropic",
    dropThinkingBlockModelHints: ["claude"],
  },
};

const PLUGIN_CAPABILITIES_FALLBACKS: Record<string, Partial<ProviderCapabilities>> = {
  anthropic: {
    providerFamily: "anthropic",
    dropThinkingBlockModelHints: ["claude"],
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
  moonshot: {
    openAiPayloadNormalizationMode: "moonshot-thinking",
  },
  "kimi-coding": {
    openAiPayloadNormalizationMode: "moonshot-thinking",
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
};

const defaultResolveProviderCapabilitiesWithPlugin = resolveProviderCapabilitiesWithPluginRuntime;
const providerCapabilityDeps = {
  resolveProviderCapabilitiesWithPlugin: defaultResolveProviderCapabilitiesWithPlugin,
};

export const __testing = {
  setResolveProviderCapabilitiesWithPluginForTest(
    resolveProviderCapabilitiesWithPlugin?: typeof defaultResolveProviderCapabilitiesWithPlugin,
  ): void {
    providerCapabilityDeps.resolveProviderCapabilitiesWithPlugin =
      resolveProviderCapabilitiesWithPlugin ?? defaultResolveProviderCapabilitiesWithPlugin;
  },
  resetDepsForTests(): void {
    providerCapabilityDeps.resolveProviderCapabilitiesWithPlugin =
      defaultResolveProviderCapabilitiesWithPlugin;
  },
};

export function resolveProviderCapabilities(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): ProviderCapabilities {
  const normalized = normalizeProviderId(provider ?? "");
  const pluginCapabilities = normalized
    ? providerCapabilityDeps.resolveProviderCapabilitiesWithPlugin({
        provider: normalized,
        config: options?.config,
        workspaceDir: options?.workspaceDir,
        env: options?.env,
      })
    : undefined;
  return {
    ...DEFAULT_PROVIDER_CAPABILITIES,
    ...CORE_PROVIDER_CAPABILITIES[normalized],
    ...(pluginCapabilities ?? PLUGIN_CAPABILITIES_FALLBACKS[normalized]),
  };
}

export function preservesAnthropicThinkingSignatures(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): boolean {
  return resolveProviderCapabilities(provider, options).preserveAnthropicThinkingSignatures;
}

export function requiresOpenAiCompatibleAnthropicToolPayload(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): boolean {
  const capabilities = resolveProviderCapabilities(provider, options);
  return (
    capabilities.anthropicToolSchemaMode !== "native" ||
    capabilities.anthropicToolChoiceMode !== "native"
  );
}

export function usesOpenAiFunctionAnthropicToolSchema(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): boolean {
  return (
    resolveProviderCapabilities(provider, options).anthropicToolSchemaMode === "openai-functions"
  );
}

export function usesOpenAiStringModeAnthropicToolChoice(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): boolean {
  return (
    resolveProviderCapabilities(provider, options).anthropicToolChoiceMode === "openai-string-modes"
  );
}

export function supportsOpenAiCompatTurnValidation(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): boolean {
  return resolveProviderCapabilities(provider, options).openAiCompatTurnValidation;
}

export function usesMoonshotThinkingPayloadCompat(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): boolean {
  return (
    resolveProviderCapabilities(provider, options).openAiPayloadNormalizationMode ===
    "moonshot-thinking"
  );
}

export function sanitizesGeminiThoughtSignatures(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): boolean {
  return resolveProviderCapabilities(provider, options).geminiThoughtSignatureSanitization;
}

function modelIncludesAnyHint(modelId: string | null | undefined, hints: string[]): boolean {
  const normalized = (modelId ?? "").toLowerCase();
  return Boolean(normalized) && hints.some((hint) => normalized.includes(hint));
}

export function isOpenAiProviderFamily(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): boolean {
  return resolveProviderCapabilities(provider, options).providerFamily === "openai";
}

export function isAnthropicProviderFamily(
  provider?: string | null,
  options?: ProviderCapabilityLookupOptions,
): boolean {
  return resolveProviderCapabilities(provider, options).providerFamily === "anthropic";
}

export function shouldDropThinkingBlocksForModel(params: {
  provider?: string | null;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return modelIncludesAnyHint(
    params.modelId,
    resolveProviderCapabilities(params.provider, params).dropThinkingBlockModelHints,
  );
}

export function shouldSanitizeGeminiThoughtSignaturesForModel(params: {
  provider?: string | null;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const capabilities = resolveProviderCapabilities(params.provider, params);
  return (
    capabilities.geminiThoughtSignatureSanitization &&
    modelIncludesAnyHint(params.modelId, capabilities.geminiThoughtSignatureModelHints)
  );
}

export function resolveTranscriptToolCallIdMode(
  provider?: string | null,
  modelId?: string | null,
  options?: ProviderCapabilityLookupOptions,
): "strict9" | undefined {
  const capabilities = resolveProviderCapabilities(provider, options);
  const mode = capabilities.transcriptToolCallIdMode;
  if (mode === "strict9") {
    return mode;
  }
  if (modelIncludesAnyHint(modelId, capabilities.transcriptToolCallIdModelHints)) {
    return "strict9";
  }
  return undefined;
}
