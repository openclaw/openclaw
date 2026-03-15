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

/**
 * Azure OpenAI requires `api-version` as a URL query parameter, not a header.
 * When the base URL targets Azure (*.openai.azure.com) and the model headers
 * contain `api-version`, move it from headers to a query parameter on the URL.
 */
function normalizeAzureApiVersion(model: Model<Api>): Model<Api> {
  const baseUrl = model.baseUrl?.trim();
  if (!baseUrl) {
    return model;
  }

  let isAzure: boolean;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    isAzure = hostname.endsWith(".openai.azure.com") || hostname.endsWith(".services.ai.azure.com");
  } catch {
    const lower = baseUrl.toLowerCase();
    isAzure = lower.includes(".openai.azure.com") || lower.includes(".services.ai.azure.com");
  }
  if (!isAzure) {
    return model;
  }

  const headers = (model as unknown as { headers?: Record<string, string> }).headers;
  if (!headers) {
    return model;
  }

  const versionKey = Object.keys(headers).find((k) => k.toLowerCase() === "api-version");
  if (!versionKey) {
    return model;
  }

  const versionValue = String(headers[versionKey] ?? "").trim();
  if (!versionValue) {
    return model;
  }

  // Append api-version as a query param to the base URL.
  let nextBaseUrl: string;
  try {
    const url = new URL(baseUrl);
    if (!url.searchParams.has("api-version")) {
      url.searchParams.set("api-version", versionValue);
    }
    nextBaseUrl = url.toString();
  } catch {
    // Fallback: simple string append.
    const separator = baseUrl.includes("?") ? "&" : "?";
    nextBaseUrl = `${baseUrl}${separator}api-version=${encodeURIComponent(versionValue)}`;
  }

  // Remove api-version from headers.
  const { [versionKey]: _removed, ...remainingHeaders } = headers;

  return {
    ...model,
    baseUrl: nextBaseUrl,
    headers: Object.keys(remainingHeaders).length > 0 ? remainingHeaders : undefined,
  } as Model<Api>;
}

export function normalizeResolvedProviderModel(params: {
  provider: string;
  model: Model<Api>;
}): Model<Api> {
  const normalizedOpenAI = normalizeOpenAITransport(params);
  const normalizedCodex = normalizeOpenAICodexTransport({
    provider: params.provider,
    model: normalizedOpenAI,
  });
  const normalizedAzure = normalizeAzureApiVersion(normalizedCodex);
  return normalizeModelCompat(normalizedAzure);
}
