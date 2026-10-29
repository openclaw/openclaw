const MEDIA_PROVIDER_ALIASES = new Map([
  ["gemini", "google"],
  ["minimax-cn", "minimax"],
  ["minimax-portal-cn", "minimax-portal"],
]);

/** Normalize provider aliases to canonical config provider ids. */
export function normalizeMediaProviderId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return MEDIA_PROVIDER_ALIASES.get(normalized) ?? normalized;
}

/** Normalize provider ids while preserving execution-specific regional aliases. */
export function normalizeMediaExecutionProviderId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return normalized === "gemini" ? "google" : normalized;
}
