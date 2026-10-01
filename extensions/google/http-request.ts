import {
  resolveProviderHttpRequestConfig,
  type ProviderRequestTransportOverrides,
} from "openclaw/plugin-sdk/provider-http";
import { parseGeminiAuth } from "./gemini-auth.js";
import { resolveGoogleApiClientHeaders } from "./google-api-client-header.js";
import {
  DEFAULT_GOOGLE_API_BASE_URL,
  normalizeGoogleGenerativeAiBaseUrl,
} from "./provider-policy.js";

type GoogleGenerativeAiRequestOverrides = ProviderRequestTransportOverrides & {
  allowPrivateNetwork?: boolean;
};

function resolveTrustedGoogleGenerativeAiBaseUrl(baseUrl?: string): string {
  const normalized = normalizeGoogleGenerativeAiBaseUrl(baseUrl) ?? DEFAULT_GOOGLE_API_BASE_URL;
  const url = URL.parse(normalized);
  if (!url) {
    throw new Error(
      "Google Generative AI baseUrl must be a valid https URL on generativelanguage.googleapis.com",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "generativelanguage.googleapis.com"
  ) {
    throw new Error(
      "Google Generative AI baseUrl must use https://generativelanguage.googleapis.com",
    );
  }
  return normalized;
}

export function resolveGoogleGenerativeAiHttpRequestConfig(params: {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: GoogleGenerativeAiRequestOverrides;
  capability: "image" | "audio" | "video";
  transport: "http" | "media-understanding";
}) {
  const baseUrl = resolveTrustedGoogleGenerativeAiBaseUrl(params.baseUrl);
  return resolveProviderHttpRequestConfig({
    baseUrl,
    defaultBaseUrl: DEFAULT_GOOGLE_API_BASE_URL,
    allowPrivateNetwork: params.request?.allowPrivateNetwork,
    headers: params.headers,
    request: params.request,
    defaultHeaders: {
      ...parseGeminiAuth(params.apiKey).headers,
      ...resolveGoogleApiClientHeaders({
        baseUrl,
        api: "google-generative-ai",
        capability: params.capability,
        transport: params.transport,
      }),
    },
    provider: "google",
    api: "google-generative-ai",
    capability: params.capability,
    transport: params.transport,
  });
}
