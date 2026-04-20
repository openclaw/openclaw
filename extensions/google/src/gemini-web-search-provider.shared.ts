import {
  readProviderEnvValue as readSearchEnvValue,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveGoogleApiType, resolveGoogleBaseUrl } from "../env-utils.js";

export const DEFAULT_GEMINI_WEB_SEARCH_MODEL = "gemini-2.5-flash";

export type GeminiConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  apiType?: "gemini" | "openai-compatible";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveGeminiConfig(searchConfig?: Record<string, unknown>): GeminiConfig {
  const gemini = searchConfig?.gemini;
  return isRecord(gemini) ? (gemini as GeminiConfig) : {};
}

export function resolveGeminiApiKey(
  gemini?: GeminiConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    trimToUndefined(gemini?.apiKey) ??
    trimToUndefined(env.GEMINI_API_KEY) ??
    trimToUndefined(env.GOOGLE_API_KEY) ??
    readSearchEnvValue(["GEMINI_API_KEY", "GOOGLE_API_KEY"])
  );
}

export function resolveGeminiModel(gemini?: GeminiConfig): string {
  return normalizeOptionalString(gemini?.model) || DEFAULT_GEMINI_WEB_SEARCH_MODEL;
}

export function resolveGeminiBaseUrl(gemini?: GeminiConfig): string {
  return resolveGoogleBaseUrl(trimToUndefined(gemini?.baseUrl));
}

export function resolveGeminiApiType(gemini?: GeminiConfig): "gemini" | "openai-compatible" {
  const baseUrl = resolveGeminiBaseUrl(gemini);
  return resolveGoogleApiType(baseUrl, trimToUndefined(gemini?.apiType));
}
