const MEDIA_PROVIDER_ALIASES = new Map([
  ["gemini", "google"],
  ["minimax-cn", "minimax"],
  ["minimax-portal-cn", "minimax-portal"],
]);

/** Normalize the spelling of a provider id without changing its identity. */
export function normalizeMediaProviderKey(id: string): string {
  return id.trim().toLowerCase();
}

/** Normalize provider aliases to canonical config provider ids. */
export function normalizeMediaProviderId(id: string): string {
  const normalized = normalizeMediaProviderKey(id);
  return MEDIA_PROVIDER_ALIASES.get(normalized) ?? normalized;
}

/** Normalize provider ids while preserving execution-specific regional aliases. */
export function normalizeMediaExecutionProviderId(id: string): string {
  const normalized = normalizeMediaProviderKey(id);
  return normalized === "gemini" ? "google" : normalized;
}

/** An exact registration takes precedence over the historical fallback. */
export function resolveMediaProviderKey(
  id: string,
  registry: ReadonlyMap<string, unknown>,
  fallback = normalizeMediaProviderId,
): string {
  const exact = normalizeMediaProviderKey(id);
  return registry.has(exact) ? exact : fallback(exact);
}

export function getMediaProviderFromRegistry<T>(
  id: string,
  registry: ReadonlyMap<string, T>,
): T | undefined {
  return registry.get(resolveMediaProviderKey(id, registry));
}
