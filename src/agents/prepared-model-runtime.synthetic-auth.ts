/** Synthetic-auth provider ref selection and prepared-catalog resolution for model-runtime builds. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ProviderPlugin } from "../plugins/types.js";

// Provider-scoped live builds must not fan ambient synthetic-auth discovery out to every
// registered provider; each unscoped ref can force a full plugin module load on the read path.
export function scopeSyntheticAuthProviderRefs(
  refs: readonly string[],
  providerDiscoveryProviderIds: readonly string[] | undefined,
): string[] {
  if (!providerDiscoveryProviderIds) {
    return [...refs];
  }
  const scoped = new Set(providerDiscoveryProviderIds.map((id) => normalizeProviderId(id)));
  // OpenAI's native runtime has a separate auth namespace, never a bearer alias.
  if (scoped.has("openai")) {
    scoped.add("codex");
  }
  return refs.filter((ref) => scoped.has(normalizeProviderId(ref)));
}

export function listPreparedSyntheticAuthProviderRefs(
  providers: readonly ProviderPlugin[],
): string[] {
  return [
    ...new Set(
      providers.flatMap((provider) =>
        provider.resolveSyntheticAuth || provider.prepareSyntheticAuth
          ? [provider.id, ...(provider.aliases ?? []), ...(provider.hookAliases ?? [])]
          : [],
      ),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}
