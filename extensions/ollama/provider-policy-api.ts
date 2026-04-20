// Inlined to avoid custom source-loader resolution issues
const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

/**
 * Provider policy surface for Ollama: normalize provider configs used by
 * core defaults/normalizers. This runs during config defaults application and
 * normalization paths (not Zod validation).
 */
export function normalizeConfig({
  provider,
  providerConfig,
}: {
  provider: string;
  providerConfig: unknown;
}): unknown {
  if (!providerConfig || typeof providerConfig !== "object") {
    return providerConfig;
  }

  // provider is already a string, no need for String() cast
  const normalizedProviderId = (provider ?? "").trim().toLowerCase();
  if (normalizedProviderId !== "ollama") {
    return providerConfig;
  }

  // Safely cast to Record to allow mutations without 'any'
  const next: Record<string, unknown> = { ...(providerConfig as Record<string, unknown>) };

  // If baseUrl is missing, empty, or whitespace-only, default to local Ollama host.
  if (typeof next.baseUrl !== "string" || !next.baseUrl.trim()) {
    next.baseUrl = OLLAMA_DEFAULT_BASE_URL;
  }

  // If models is missing/not an array, default to empty array to signal discovery
  if (!Array.isArray(next.models)) {
    next.models = [];
  }

  return next;
}
