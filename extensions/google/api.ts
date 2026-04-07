import {
  resolveProviderEndpoint,
  resolveProviderHttpRequestConfig,
  type ProviderRequestTransportOverrides,
} from "openclaw/plugin-sdk/provider-http";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { normalizeAntigravityModelId, normalizeGoogleModelId } from "./model-id.js";
import { parseGoogleOauthApiKey } from "./oauth-token-shared.js";
export { normalizeAntigravityModelId, normalizeGoogleModelId };

type GoogleApiCarrier = {
  api?: string | null;
};

type GoogleProviderConfigLike = GoogleApiCarrier & {
  models?: ReadonlyArray<GoogleApiCarrier | null | undefined> | null;
};

export const DEFAULT_GOOGLE_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function isCanonicalGoogleApiOriginShorthand(value: string): boolean {
  return /^https:\/\/generativelanguage\.googleapis\.com\/?$/i.test(value);
}

export function normalizeGoogleApiBaseUrl(baseUrl?: string): string {
  const raw = trimTrailingSlashes(baseUrl?.trim() || DEFAULT_GOOGLE_API_BASE_URL);
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    if (
      resolveProviderEndpoint(url.toString()).endpointClass === "google-generative-ai" &&
      trimTrailingSlashes(url.pathname || "") === ""
    ) {
      url.pathname = "/v1beta";
    }
    return trimTrailingSlashes(url.toString());
  } catch {
    if (isCanonicalGoogleApiOriginShorthand(raw)) {
      return DEFAULT_GOOGLE_API_BASE_URL;
    }
    return raw;
  }
}

export function isGoogleGenerativeAiApi(api?: string | null): boolean {
  return api === "google-generative-ai";
}

export function normalizeGoogleGenerativeAiBaseUrl(baseUrl?: string): string | undefined {
  return baseUrl ? normalizeGoogleApiBaseUrl(baseUrl) : baseUrl;
}

export function resolveGoogleGenerativeAiTransport<TApi extends string | null | undefined>(params: {
  api: TApi;
  baseUrl?: string;
}): { api: TApi; baseUrl?: string } {
  return {
    api: params.api,
    baseUrl: isGoogleGenerativeAiApi(params.api)
      ? normalizeGoogleGenerativeAiBaseUrl(params.baseUrl)
      : params.baseUrl,
  };
}

export function resolveGoogleGenerativeAiApiOrigin(baseUrl?: string): string {
  return normalizeGoogleApiBaseUrl(baseUrl).replace(/\/v1beta$/i, "");
}

export function shouldNormalizeGoogleGenerativeAiProviderConfig(
  providerKey: string,
  provider: GoogleProviderConfigLike,
): boolean {
  if (providerKey === "google" || providerKey === "google-vertex") {
    return true;
  }
  if (isGoogleGenerativeAiApi(provider.api)) {
    return true;
  }
  return provider.models?.some((model) => isGoogleGenerativeAiApi(model?.api)) ?? false;
}

export function shouldNormalizeGoogleProviderConfig(
  providerKey: string,
  provider: GoogleProviderConfigLike,
): boolean {
  return (
    providerKey === "google-antigravity" ||
    shouldNormalizeGoogleGenerativeAiProviderConfig(providerKey, provider)
  );
}

function normalizeProviderModels(
  provider: ModelProviderConfig,
  normalizeId: (id: string) => string,
): ModelProviderConfig {
  const models = provider.models;
  if (!Array.isArray(models) || models.length === 0) {
    return provider;
  }

  let mutated = false;
  const nextModels = models.map((model) => {
    const nextId = normalizeId(model.id);
    if (nextId === model.id) {
      return model;
    }
    mutated = true;
    return { ...model, id: nextId };
  });

  return mutated ? { ...provider, models: nextModels } : provider;
}

export function normalizeGoogleProviderConfig(
  providerKey: string,
  provider: ModelProviderConfig,
): ModelProviderConfig {
  let nextProvider = provider;

  if (shouldNormalizeGoogleGenerativeAiProviderConfig(providerKey, nextProvider)) {
    const modelNormalized = normalizeProviderModels(nextProvider, normalizeGoogleModelId);
    const normalizedBaseUrl = normalizeGoogleGenerativeAiBaseUrl(modelNormalized.baseUrl);
    nextProvider =
      normalizedBaseUrl !== modelNormalized.baseUrl
        ? { ...modelNormalized, baseUrl: normalizedBaseUrl ?? modelNormalized.baseUrl }
        : modelNormalized;
  }

  if (providerKey === "google-antigravity") {
    nextProvider = normalizeProviderModels(nextProvider, normalizeAntigravityModelId);
  }

  return nextProvider;
}

export function parseGeminiAuth(apiKey: string): { headers: Record<string, string> } {
  const parsed = apiKey.startsWith("{") ? parseGoogleOauthApiKey(apiKey) : null;
  if (parsed?.token) {
    return {
      headers: {
        Authorization: `Bearer ${parsed.token}`,
        "Content-Type": "application/json",
      },
    };
  }

  return {
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
  };
}

export function resolveGoogleGenerativeAiHttpRequestConfig(params: {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: ProviderRequestTransportOverrides;
  capability: "image" | "audio" | "video";
  transport: "http" | "media-understanding";
}) {
  return resolveProviderHttpRequestConfig({
    baseUrl: normalizeGoogleApiBaseUrl(params.baseUrl ?? DEFAULT_GOOGLE_API_BASE_URL),
    defaultBaseUrl: DEFAULT_GOOGLE_API_BASE_URL,
    allowPrivateNetwork: Boolean(params.baseUrl?.trim()),
    headers: params.headers,
    request: params.request,
    defaultHeaders: parseGeminiAuth(params.apiKey).headers,
    provider: "google",
    api: "google-generative-ai",
    capability: params.capability,
    transport: params.transport,
  });
}

export const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3.1-pro-preview";

export function applyGoogleGeminiModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
} {
  const current = cfg.agents?.defaults?.model as unknown;
  const currentPrimary =
    typeof current === "string"
      ? current.trim() || undefined
      : current &&
          typeof current === "object" &&
          typeof (current as { primary?: unknown }).primary === "string"
        ? ((current as { primary: string }).primary || "").trim() || undefined
        : undefined;
  if (currentPrimary === GOOGLE_GEMINI_DEFAULT_MODEL) {
    return { next: cfg, changed: false };
  }
  return {
    next: applyAgentDefaultModelPrimary(cfg, GOOGLE_GEMINI_DEFAULT_MODEL),
    changed: true,
  };
}
