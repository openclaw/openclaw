import { OLLAMA_DEFAULT_BASE_URL } from "./src/defaults.js";

/**
 * Provider policy surface for Ollama: normalize provider configs used by
 * core defaults/normalizers. This runs during config defaults application and
 * normalization paths (not Zod validation). It ensures the Ollama provider
 * config uses the native Ollama default base URL when baseUrl is omitted.
 *
 * Keep this intentionally small: do not change types or try to sidestep core
 * schema validation. This helper makes runtime normalization and defaults
 * consistent for Ollama-only paths.
 */
export function normalizeConfig({ provider, providerConfig }) {
  if (!providerConfig || typeof providerConfig !== "object") {
    return providerConfig;
  }

  // Only normalize the Ollama provider; be tolerant of provider aliasing/case.
  const normalizedProviderId = String(provider ?? "")
    .trim()
    .toLowerCase();
  if (normalizedProviderId !== "ollama") {
    return providerConfig;
  }

  const next = { ...providerConfig };
  // If baseUrl is missing/empty, default to local Ollama host. Do not override
  // a deliberately-set empty string or non-string value beyond normalization.
  if (typeof next.baseUrl !== "string" || !next.baseUrl.trim()) {
    next.baseUrl = OLLAMA_DEFAULT_BASE_URL;
  }

  // If models is missing/not an array, default to empty array to signal
  // that discovery should run to populate models.
  if (!Array.isArray(next.models)) {
    next.models = [];
  }

  return next;
}
