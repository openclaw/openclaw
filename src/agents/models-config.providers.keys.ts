/** Canonical provider-key handling shared by models.json merge boundaries. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";

export function normalizeProviderMapKeys<T>(
  providers: Record<string, T> | null | undefined,
): Record<string, T> {
  const entries = Object.entries(providers ?? {});
  const canonicalKeys = new Set<string>();
  for (const [key] of entries) {
    const providerKey = normalizeProviderId(key);
    if (providerKey && key === providerKey) {
      canonicalKeys.add(providerKey);
    }
  }

  const normalized: Record<string, T> = {};
  for (const [key, value] of entries) {
    const providerKey = normalizeProviderId(key);
    if (!providerKey || (canonicalKeys.has(providerKey) && key !== providerKey)) {
      continue;
    }
    // Exact canonical spelling wins over aliases regardless of object order.
    // Without one, the later variant wins, matching existing trim-collision behavior.
    normalized[providerKey] = value;
  }
  return normalized;
}
