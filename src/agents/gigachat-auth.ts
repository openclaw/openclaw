import { GIGACHAT_BASIC_BASE_URL, GIGACHAT_BASE_URL } from "../commands/onboard-auth.models.js";
import type { AuthProfileStore } from "./auth-profiles.js";

export type GigachatAuthMetadata = Record<string, string> | undefined;

export function resolveGigachatAuthProfileMetadata(
  store: Pick<AuthProfileStore, "profiles">,
  authProfileId?: string,
  options?: {
    allowDefaultProfileFallback?: boolean;
  },
): GigachatAuthMetadata {
  const profileIds = [
    authProfileId?.trim(),
    options?.allowDefaultProfileFallback === false ? undefined : "gigachat:default",
  ].filter((profileId): profileId is string => Boolean(profileId));
  for (const profileId of profileIds) {
    const credential = store.profiles[profileId];
    if (credential?.type === "api_key" && credential.provider === "gigachat") {
      return credential.metadata;
    }
  }
  return undefined;
}

export function resolveGigachatInsecureTlsOverride(
  metadata?: GigachatAuthMetadata,
): boolean | undefined {
  if (metadata?.insecureTls === "true") {
    return true;
  }
  if (metadata?.insecureTls === "false") {
    return false;
  }
  return undefined;
}

function looksLikeGigachatBasicCredentials(apiKey: string | undefined): boolean {
  const trimmed = apiKey?.trim();
  if (!trimmed) {
    return false;
  }
  const separatorIndex = trimmed.indexOf(":");
  // OAuth credential keys can legitimately contain additional ":" segments, so
  // only infer Basic auth for the obvious single-separator user:password shape.
  return separatorIndex > 0 && separatorIndex === trimmed.lastIndexOf(":");
}

function normalizeGigachatBaseUrlForComparison(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

export function resolveGigachatAuthMode(params: {
  metadata?: GigachatAuthMetadata;
  apiKey?: string;
  authProfileId?: string;
}): "oauth" | "basic" {
  const metadataAuthMode = params.metadata?.authMode;
  if (metadataAuthMode === "basic" || metadataAuthMode === "oauth") {
    return metadataAuthMode;
  }

  if (looksLikeGigachatBasicCredentials(params.apiKey)) {
    return "basic";
  }

  return "oauth";
}

function resolveGigachatDefaultBaseUrl(params: {
  metadata?: GigachatAuthMetadata;
  apiKey?: string;
  authProfileId?: string;
}): string {
  return resolveGigachatAuthMode(params) === "basic" ? GIGACHAT_BASIC_BASE_URL : GIGACHAT_BASE_URL;
}

export function resolveImplicitGigachatBaseUrl(params: {
  envBaseUrl?: string;
  metadata?: GigachatAuthMetadata;
  apiKey?: string;
  authProfileId?: string;
}): string {
  const envBaseUrl = params.envBaseUrl?.trim();
  if (envBaseUrl) {
    return envBaseUrl;
  }
  return resolveGigachatDefaultBaseUrl(params);
}

export function resolveConfiguredGigachatBaseUrl(params: {
  baseUrl?: string;
  envBaseUrl?: string;
  metadata?: GigachatAuthMetadata;
  apiKey?: string;
  authProfileId?: string;
}): string {
  const baseUrl = params.baseUrl?.trim();
  if (baseUrl) {
    const normalizedBaseUrl = normalizeGigachatBaseUrlForComparison(baseUrl);
    // Treat stock hosts as implicit defaults so they follow the resolved auth mode,
    // while preserving any genuinely custom endpoint overrides.
    if (normalizedBaseUrl === GIGACHAT_BASE_URL || normalizedBaseUrl === GIGACHAT_BASIC_BASE_URL) {
      return resolveGigachatDefaultBaseUrl(params);
    }
    return baseUrl;
  }
  return resolveImplicitGigachatBaseUrl(params);
}
