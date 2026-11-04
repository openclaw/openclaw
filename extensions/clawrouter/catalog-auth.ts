import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { buildClawRouterProviderConfig } from "./provider-catalog.js";

// Keep the existing ClawRouter profile resolver and its locked-profile behavior
// at the catalog entrypoint. Discovery never resolves an upstream provider key.
export async function buildClawRouterAuthenticatedCatalog(
  ctx: ProviderCatalogContext,
  baseUrl: string | undefined,
) {
  const auth = ctx.resolveProviderAuth("clawrouter");
  let discoveryApiKey = auth.discoveryApiKey;
  if (!discoveryApiKey) {
    try {
      const { resolveApiKeyForProvider } =
        await import("openclaw/plugin-sdk/provider-auth-runtime");
      discoveryApiKey = (
        await resolveApiKeyForProvider({
          provider: "clawrouter",
          cfg: ctx.config,
          ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
          ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
          ...(auth.profileId ? { profileId: auth.profileId, lockedProfile: true } : {}),
        })
      )?.apiKey;
    } catch {
      return null;
    }
  }
  const apiKey = auth.apiKey ?? discoveryApiKey;
  if (!apiKey || !discoveryApiKey) {
    return null;
  }
  return {
    provider: await buildClawRouterProviderConfig({
      apiKey,
      discoveryApiKey,
      baseUrl,
      profileId: auth.profileId,
      signal: ctx.signal,
    }),
  };
}
