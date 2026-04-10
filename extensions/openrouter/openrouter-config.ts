import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function resolveConfiguredBaseUrl(
  cfg: { models?: { providers?: Record<string, { baseUrl?: string }> } } | undefined,
): string | undefined {
  return normalizeOptionalString(cfg?.models?.providers?.openrouter?.baseUrl);
}
