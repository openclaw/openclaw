import type { Api, Model } from "@mariozechner/pi-ai";
import { normalizeModelCompat } from "../model-compat.js";
import { normalizeProviderId } from "../model-selection.js";

const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

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

function normalizeOpenAICodexTransport(params: {
  provider: string;
  model: Model<Api>;
}): Model<Api> {
  if (normalizeProviderId(params.provider) !== "openai-codex") {
    return params.model;
  }

  const useCodexTransport =
    !params.model.baseUrl ||
    isOpenAIApiBaseUrl(params.model.baseUrl) ||
    isOpenAICodexBaseUrl(params.model.baseUrl);

  const nextApi =
    useCodexTransport && params.model.api === "openai-responses"
      ? ("openai-codex-responses" as const)
      : params.model.api;
  const nextBaseUrl =
    nextApi === "openai-codex-responses" &&
    (!params.model.baseUrl || isOpenAIApiBaseUrl(params.model.baseUrl))
      ? OPENAI_CODEX_BASE_URL
      : params.model.baseUrl;

  if (nextApi === params.model.api && nextBaseUrl === params.model.baseUrl) {
    return params.model;
  }

  return {
    ...params.model,
    api: nextApi,
    baseUrl: nextBaseUrl,
  } as Model<Api>;
}

export function normalizeResolvedProviderModel(params: {
  provider: string;
  model: Model<Api>;
}): Model<Api> {
  return normalizeModelCompat(normalizeOpenAICodexTransport(params));
}
