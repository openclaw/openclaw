import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { normalizeAntigravityModelId, normalizeGoogleModelId } from "./model-id.js";

type GoogleApiCarrier = {
  api?: string | null;
};

type GoogleProviderConfigLike = GoogleApiCarrier & {
  models?: ReadonlyArray<GoogleApiCarrier | null | undefined> | null;
};

export const DEFAULT_GOOGLE_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function isCanonicalGoogleApiOriginShorthand(value: string): boolean {
  return /^https:\/\/generativelanguage\.googleapis\.com\/?$/i.test(value);
}

function isGoogleGenerativeAiUrl(url: URL): boolean {
  return (
    url.protocol === "https:" && url.hostname.toLowerCase() === "generativelanguage.googleapis.com"
  );
}

export function normalizeGoogleApiBaseUrl(baseUrl?: string): string {
  const raw = trimTrailingSlashes(normalizeOptionalString(baseUrl) || DEFAULT_GOOGLE_API_BASE_URL);
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    if (isGoogleGenerativeAiUrl(url) && trimTrailingSlashes(url.pathname || "") === "") {
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
