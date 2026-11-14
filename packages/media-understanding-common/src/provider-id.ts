const MEDIA_PROVIDER_ALIASES = new Map([
  ["gemini", "google"],
  ["minimax-cn", "minimax"],
  ["minimax-portal-cn", "minimax-portal"],
]);

type MediaProviderIdentities = { has(id: string): boolean };

/** Prefer declared provider identities, retaining historical aliases when unclaimed. */
export function normalizeMediaProviderId(
  id: string,
  registeredProviders?: MediaProviderIdentities,
): string {
  const normalized = id.trim().toLowerCase();
  return registeredProviders?.has(normalized)
    ? normalized
    : (MEDIA_PROVIDER_ALIASES.get(normalized) ?? normalized);
}

/** Normalize provider ids while preserving execution-specific regional aliases. */
export function normalizeMediaExecutionProviderId(
  id: string,
  registeredProviders?: MediaProviderIdentities,
): string {
  const normalized = id.trim().toLowerCase();
  return normalized === "gemini" && !registeredProviders?.has(normalized) ? "google" : normalized;
}
