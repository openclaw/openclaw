// Lightweight Google API URL normalization shared by provider contract surfaces.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const DEFAULT_GOOGLE_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function isGoogleGenerativeAiUrl(url: URL): boolean {
  return (
    url.protocol === "https:" && url.hostname.toLowerCase() === "generativelanguage.googleapis.com"
  );
}

/** Exact official AI Studio request root eligible for native provider behavior. */
export function isOfficialGoogleAiStudioBaseUrl(baseUrl?: string | null): boolean {
  const raw = normalizeOptionalString(baseUrl) ?? DEFAULT_GOOGLE_API_BASE_URL;
  const url = URL.parse(raw);
  const href = url ? trimTrailingSlashes(url.href) : undefined;
  return (
    href === "https://generativelanguage.googleapis.com" || href === DEFAULT_GOOGLE_API_BASE_URL
  );
}

const GOOGLE_VERTEX_HOST = "aiplatform.googleapis.com";
const GOOGLE_VERTEX_REGION_HOST_SUFFIX = "-aiplatform.googleapis.com";
const GOOGLE_VERTEX_MULTI_REGION_HOSTS = new Set([
  "aiplatform.eu.rep.googleapis.com",
  "aiplatform.us.rep.googleapis.com",
]);

export function isGoogleVertexHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === GOOGLE_VERTEX_HOST ||
    normalized.endsWith(GOOGLE_VERTEX_REGION_HOST_SUFFIX) ||
    GOOGLE_VERTEX_MULTI_REGION_HOSTS.has(normalized)
  );
}

export function isGoogleVertexBaseUrl(baseUrl?: string | null): boolean {
  const raw = normalizeOptionalString(baseUrl);
  if (!raw) {
    return false;
  }
  const url = URL.parse(raw);
  return url !== null && isGoogleVertexHostname(url.hostname);
}

export function normalizeGoogleApiBaseUrl(baseUrl?: string): string {
  const raw = trimTrailingSlashes(normalizeOptionalString(baseUrl) || DEFAULT_GOOGLE_API_BASE_URL);
  const url = URL.parse(raw);
  if (!url) {
    return raw;
  }
  url.hash = "";
  url.search = "";
  url.username = "";
  url.password = "";
  if (isGoogleGenerativeAiUrl(url)) {
    const normalizedPath = trimTrailingSlashes(url.pathname || "");
    url.pathname = normalizedPath || "/v1beta";
  }
  return trimTrailingSlashes(url.toString());
}

export function isGoogleGenerativeAiApi(api?: string | null): boolean {
  return api === "google-generative-ai";
}

export function normalizeGoogleGenerativeAiBaseUrl(baseUrl?: string): string | undefined {
  const raw = normalizeOptionalString(baseUrl);
  if (!raw) {
    return undefined;
  }

  const normalized = normalizeGoogleApiBaseUrl(raw);
  const url = URL.parse(normalized);
  if (url) {
    if (isGoogleGenerativeAiUrl(url)) {
      url.pathname = trimTrailingSlashes(url.pathname || "").replace(/\/openai$/i, "") || "/v1beta";
      return trimTrailingSlashes(url.toString());
    }
  }

  return normalized;
}
