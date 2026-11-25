import { normalizeProviderIdForAuth } from "@openclaw/model-catalog-core/provider-id";

/**
 * Decides whether an expired OAuth profile with refresh material may stay runnable, mirroring the
 * runtime OAuth manager's refresh owners: core OpenAI, external-CLI profiles, and provider plugins.
 */
export function createOAuthRefreshAuthority(
  externalCliProfiles: readonly { profileId: string }[],
  canRefreshProviderOAuth: ((provider: string) => boolean) | undefined,
): (provider: string, profileId: string) => boolean {
  // Refresh authority follows exact profiles marked by the external-auth
  // lifecycle. Provider-wide authority could bless an unrelated stale profile.
  const externalProfileIds = new Set(externalCliProfiles.map((profile) => profile.profileId));
  // Plugin refresh authority is provider-wide by contract: the runtime OAuth manager refreshes
  // any profile of a provider whose loaded plugin implements refreshOAuth.
  const pluginCache = new Map<string, boolean>();
  const canPluginRefresh = (provider: string) => {
    if (!canRefreshProviderOAuth) {
      return false;
    }
    const key = normalizeProviderIdForAuth(provider);
    let allowed = pluginCache.get(key);
    if (allowed === undefined) {
      allowed = canRefreshProviderOAuth(provider);
      pluginCache.set(key, allowed);
    }
    return allowed;
  };
  return (provider, profileId) =>
    provider === "openai" || externalProfileIds.has(profileId) || canPluginRefresh(provider);
}
