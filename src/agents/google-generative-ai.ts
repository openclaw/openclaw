import { normalizeGoogleApiBaseUrl } from "../infra/google-api-base-url.js";

type GoogleApiCarrier = {
  api?: string | null;
};

type GoogleProviderConfigLike = GoogleApiCarrier & {
  models?: ReadonlyArray<GoogleApiCarrier | null | undefined> | null;
};

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
