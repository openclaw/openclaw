import type { Api, Model } from "@mariozechner/pi-ai";
import { normalizeModelCompat } from "../../plugins/provider-model-compat.js";
import { normalizeProviderId } from "../model-selection.js";

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

export function applyBuiltInResolvedProviderTransportNormalization(params: {
  provider: string;
  model: Model<Api>;
}): Model<Api> {
  return normalizeOpenAITransport(params);
}

export function normalizeResolvedProviderModel(params: {
  provider: string;
  model: Model<Api>;
}): Model<Api> {
  return normalizeModelCompat(applyBuiltInResolvedProviderTransportNormalization(params));
}
