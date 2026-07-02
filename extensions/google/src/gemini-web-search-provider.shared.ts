// Google provider module implements model/runtime integration.
import {
  isRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeGoogleApiBaseUrl } from "../provider-policy.js";

// Use a rolling alias rather than a dated model id. Concrete ids (e.g.
// "gemini-2.5-flash") get retired by Google and then return HTTP 404 on every
// web_search call for any user who has not overridden the model. The "*-latest"
// alias always resolves to a current Flash model and keeps grounding working.
// See https://github.com/openclaw/openclaw/issues/96974.
const DEFAULT_GEMINI_WEB_SEARCH_MODEL = "gemini-flash-latest";

export type GeminiConfig = {
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  providerApiKey?: unknown;
  providerBaseUrl?: unknown;
};

export function resolveGeminiConfig(searchConfig?: Record<string, unknown>): GeminiConfig {
  const gemini = searchConfig?.gemini;
  return isRecord(gemini) ? gemini : {};
}

export function resolveGeminiApiKey(
  gemini?: GeminiConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    trimToUndefined(gemini?.apiKey) ??
    trimToUndefined(env.GEMINI_API_KEY) ??
    trimToUndefined(gemini?.providerApiKey)
  );
}

export function resolveGeminiModel(gemini?: GeminiConfig): string {
  return trimToUndefined(gemini?.model) ?? DEFAULT_GEMINI_WEB_SEARCH_MODEL;
}

export function resolveGeminiBaseUrl(gemini?: GeminiConfig): string {
  return normalizeGoogleApiBaseUrl(
    trimToUndefined(gemini?.baseUrl) ?? trimToUndefined(gemini?.providerBaseUrl),
  );
}
