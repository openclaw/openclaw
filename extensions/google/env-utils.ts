import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import { DEFAULT_GOOGLE_API_BASE_URL, normalizeGoogleApiBaseUrl } from "./api.js";

/**
 * Browser-safe environment variable reader.
 */
export function readProviderEnvValue(envVars: string[]): string | undefined {
  const env = typeof process !== "undefined" ? process.env : undefined;
  if (!env) {
    return undefined;
  }
  for (const envVar of envVars) {
    const value = normalizeSecretInput(env[envVar]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function resolveGoogleBaseUrl(
  configBaseUrl?: string,
  defaultBaseUrl: string = DEFAULT_GOOGLE_API_BASE_URL,
): string {
  const fromEnv = readProviderEnvValue([
    "GOOGLE_GEMINI_ENDPOINT",
    "GEMINI_BASE_URL",
    "GOOGLE_GEMINI_BASE_URL",
  ]);
  const raw = configBaseUrl || fromEnv || defaultBaseUrl;
  return normalizeGoogleApiBaseUrl(typeof raw === "string" ? raw : defaultBaseUrl);
}

export function resolveGoogleApiType(
  baseUrl: string,
  configApiType?: string,
): "gemini" | "openai-compatible" {
  if (configApiType === "openai-compatible" || configApiType === "gemini") {
    return configApiType;
  }
  const envApiType = readProviderEnvValue(["GEMINI_API_TYPE"]);
  if (envApiType === "openai-compatible" || envApiType === "gemini") {
    return envApiType;
  }

  const urlString = typeof baseUrl === "string" ? baseUrl : "";
  if (!urlString || urlString.includes("googleapis.com")) {
    return "gemini";
  }

  // Auto-detect OpenAI-compatible for non-Google hosts (localhost, custom proxies, etc)
  // especially if they have /v1 or if they are NOT clearly targeting Gemini native API.
  if (urlString.endsWith("/v1") || urlString.includes("/v1/")) {
    return "openai-compatible";
  }

  // If it's a custom host and doesn't look like Gemini v1beta endpoint, 
  // we default to OpenAI-compatible as it's the most common proxy protocol.
  if (!urlString.includes("/v1beta")) {
    return "openai-compatible";
  }

  return "gemini";
}
