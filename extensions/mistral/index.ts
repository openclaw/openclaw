import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { resolveProviderRequestCapabilities } from "openclaw/plugin-sdk/provider-http";
import { readStringValue } from "openclaw/plugin-sdk/text-runtime";
import { applyMistralModelCompat, MISTRAL_MODEL_COMPAT_PATCH } from "./api.js";
import { mistralMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { applyMistralConfig, MISTRAL_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildMistralProvider } from "./provider-catalog.js";

const PROVIDER_ID = "mistral";
const MISTRAL_MODEL_HINTS = [
  "mistral",
  "mistralai",
  "mixtral",
  "codestral",
  "pixtral",
  "devstral",
  "ministral",
] as const;

function isMistralModelHint(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return MISTRAL_MODEL_HINTS.some(
    (hint) =>
      normalized === hint ||
      normalized.startsWith(`${hint}/`) ||
      normalized.startsWith(`${hint}-`) ||
      normalized.startsWith(`${hint}:`),
  );
}

function shouldContributeMistralCompat(params: {
  modelId: string;
  model: { api?: unknown; baseUrl?: unknown; provider?: unknown; compat?: unknown };
}): boolean {
  if (params.model.api !== "openai-completions") {
    return false;
  }

  const capabilities = resolveProviderRequestCapabilities({
    provider: readStringValue(params.model.provider),
    api: "openai-completions",
    baseUrl: readStringValue(params.model.baseUrl),
    capability: "llm",
    transport: "stream",
    modelId: params.modelId,
    compat:
      params.model.compat && typeof params.model.compat === "object"
        ? (params.model.compat as { supportsStore?: boolean })
        : undefined,
  });

  return (
    capabilities.knownProviderFamily === "mistral" ||
    capabilities.endpointClass === "mistral-public" ||
    isMistralModelHint(params.modelId)
  );
}

function buildMistralReplayPolicy() {
  return {
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict9" as const,
  };
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Mistral Provider",
  description: "Bundled Mistral provider plugin",
  provider: {
    label: "Mistral",
    docsPath: "/providers/models",
    auth: [
      {
        methodId: "api-key",
        label: "Mistral API key",
        hint: "API key",
        optionKey: "mistralApiKey",
        flagName: "--mistral-api-key",
        envVar: "MISTRAL_API_KEY",
        promptMessage: "Enter Mistral API key",
        defaultModel: MISTRAL_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMistralConfig(cfg),
        wizard: {
          groupLabel: "Mistral AI",
        },
      },
    ],
    catalog: {
      buildProvider: buildMistralProvider,
      allowExplicitBaseUrl: true,
    },
    matchesContextOverflowError: ({ errorMessage }) =>
      /\bmistral\b.*(?:input.*too long|token limit.*exceeded)/i.test(errorMessage),
    normalizeResolvedModel: ({ model }) => applyMistralModelCompat(model),
    contributeResolvedModelCompat: ({ modelId, model }) =>
      shouldContributeMistralCompat({ modelId, model }) ? MISTRAL_MODEL_COMPAT_PATCH : undefined,
    buildReplayPolicy: () => buildMistralReplayPolicy(),
  },
  register(api) {
    api.registerMediaUnderstandingProvider(mistralMediaUnderstandingProvider);
  },
});
