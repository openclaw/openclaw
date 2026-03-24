import type { Api, Model } from "@mariozechner/pi-ai";
import { normalizeModelCompat } from "../model-compat.js";
import { normalizeProviderId } from "../model-selection.js";
import { resolveOllamaContextWindowTokens } from "../ollama-stream.js";

function isOpenAIApiBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(trimmed);
}

function normalizeOpenAITransport(params: { provider: string; model: Model<Api> }): Model<Api> {
  if (normalizeProviderId(params.provider) !== "openai") {
    return params.model;
  }

  const useResponsesTransport =
    params.model.api === "openai-completions" &&
    (!params.model.baseUrl || isOpenAIApiBaseUrl(params.model.baseUrl));

  if (!useResponsesTransport) {
    return params.model;
  }

  return {
    ...params.model,
    api: "openai-responses",
  } as Model<Api>;
}

function normalizeNativeOllamaContextWindow(params: { model: Model<Api> }): Model<Api> {
  if (params.model.api !== "ollama") {
    return params.model;
  }

  return {
    ...params.model,
    contextWindow: resolveOllamaContextWindowTokens(params.model),
  } as Model<Api>;
}

export function applyBuiltInResolvedProviderTransportNormalization(params: {
  provider: string;
  model: Model<Api>;
}): Model<Api> {
  return normalizeNativeOllamaContextWindow({
    model: normalizeOpenAITransport(params),
  });
}

export function normalizeResolvedProviderModel(params: {
  provider: string;
  model: Model<Api>;
}): Model<Api> {
  return normalizeModelCompat(applyBuiltInResolvedProviderTransportNormalization(params));
}
