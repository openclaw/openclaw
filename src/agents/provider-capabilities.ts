import { normalizeProviderId } from "./model-selection.js";

export type ProviderCapabilities = {
  providerFamily: "default" | "openai";
  openAiCompatTurnValidation: boolean;
  transcriptToolCallIdMode: "default" | "strict9";
  transcriptToolCallIdModelHints: string[];
};

const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  providerFamily: "default",
  openAiCompatTurnValidation: true,
  transcriptToolCallIdMode: "default",
  transcriptToolCallIdModelHints: [],
};

const PROVIDER_CAPABILITIES: Record<string, Partial<ProviderCapabilities>> = {
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
};

export function resolveProviderCapabilities(provider?: string | null): ProviderCapabilities {
  const normalized = normalizeProviderId(provider ?? "");
  return {
    ...DEFAULT_PROVIDER_CAPABILITIES,
    ...PROVIDER_CAPABILITIES[normalized],
  };
}

function modelIncludesAnyHint(modelId: string | null | undefined, hints: string[]): boolean {
  const normalized = (modelId ?? "").toLowerCase();
  return Boolean(normalized) && hints.some((hint) => normalized.includes(hint));
}

export function isOpenAiProviderFamily(provider?: string | null): boolean {
  return resolveProviderCapabilities(provider).providerFamily === "openai";
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
