import type { Api, Model } from "@mariozechner/pi-ai";
import { normalizeModelCompat } from "../model-compat.js";
import { normalizeProviderId } from "../model-selection.js";

function isOpenAIApiBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(trimmed);
}

function isOpenAICodexBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/chatgpt\.com\/backend-api\/?$/i.test(trimmed);
}

function normalizeOpenAITransport(params: { provider: string; model: Model<Api> }): Model<Api> {
  const provider = normalizeProviderId(params.provider);
  const isOpenAI = provider === "openai";
  const isOpenAICodex = provider === "openai-codex";
  const isOpenRouter = provider === "openrouter";

  if (!isOpenAI && !isOpenAICodex && !isOpenRouter) {
    return params.model;
  }

  const useResponsesTransport =
    params.model.api === "openai-completions" &&
    (!params.model.baseUrl ||
      (isOpenAI && isOpenAIApiBaseUrl(params.model.baseUrl)) ||
      (isOpenAICodex &&
        (isOpenAIApiBaseUrl(params.model.baseUrl) || isOpenAICodexBaseUrl(params.model.baseUrl))) ||
      isOpenRouter);

  if (!useResponsesTransport) {
    return params.model;
  }

  const isCodexProvider = isOpenAICodex;

  return {
    ...params.model,
    api: isCodexProvider ? "openai-codex-responses" : "openai-responses",
    baseUrl:
      isCodexProvider && (!params.model.baseUrl || isOpenAIApiBaseUrl(params.model.baseUrl))
        ? "https://chatgpt.com/backend-api"
        : params.model.baseUrl,
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
