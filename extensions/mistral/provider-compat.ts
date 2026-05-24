import { resolveProviderRequestCapabilities } from "openclaw/plugin-sdk/provider-http";
import {
  normalizeLowercaseStringOrEmpty,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { MISTRAL_MODEL_TRANSPORT_PATCH } from "./api.js";

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
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return MISTRAL_MODEL_HINTS.some(
    (hint) =>
      normalized === hint ||
      normalized.startsWith(`${hint}/`) ||
      normalized.startsWith(`${hint}-`) ||
      normalized.startsWith(`${hint}:`),
  );
}

function resolveMistralCompatRoute(params: {
  modelId: string;
  model: { api?: unknown; baseUrl?: unknown; provider?: unknown; compat?: unknown };
}): "direct" | "hinted" | undefined {
  if (params.model.api !== "openai-completions") {
    return undefined;
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

  if (capabilities.endpointClass === "mistral-public") {
    return "direct";
  }
  if (isMistralModelHint(params.modelId)) {
    return "hinted";
  }
  return undefined;
}

export function contributeMistralResolvedModelCompat(params: {
  modelId: string;
  model: { api?: unknown; baseUrl?: unknown; provider?: unknown; compat?: unknown };
}) {
  const route = resolveMistralCompatRoute(params);
  if (!route) {
    return undefined;
  }
  if (route === "direct") {
    return MISTRAL_MODEL_TRANSPORT_PATCH;
  }
  return {
    ...MISTRAL_MODEL_TRANSPORT_PATCH,
    supportsPromptCacheKey: false,
  };
}
