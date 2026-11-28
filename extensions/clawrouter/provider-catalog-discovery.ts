import { shouldUseEnvHttpProxyForUrl } from "openclaw/plugin-sdk/fetch-runtime";
import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeClawRouterRootUrl } from "./base-url.js";
import type { ClawRouterCatalogObservation } from "./capability-offers.js";
import { buildClawRouterProviderConfig } from "./provider-catalog.js";

const PROVIDER_ID = "clawrouter";

// Only the first page from this discovery may satisfy the ordinary chat reader.
function withObservedCatalogPage(
  observed: ClawRouterCatalogObservation,
): LiveModelCatalogFetchGuard {
  const sent = new Headers(observed.requestHeaders);
  sent.delete("x-clawrouter-client");
  let available = true;
  return async (request) => {
    const wanted = new Headers(request.init?.headers);
    if (
      available &&
      request.url === observed.url &&
      [...sent].length === [...wanted].length &&
      [...wanted].every(([name, value]) => sent.get(name) === value)
    ) {
      available = false;
      request.signal?.throwIfAborted();
      return {
        response: observed.response,
        finalUrl: observed.url,
        release: async () => undefined,
      };
    }
    return fetchWithSsrFGuard(request);
  };
}

export async function discoverClawRouterProviderCatalog(
  ctx: ProviderCatalogContext,
): Promise<ProviderCatalogResult> {
  const auth = ctx.resolveProviderAuth(PROVIDER_ID);
  let discoveryApiKey = auth.discoveryApiKey;
  if (!discoveryApiKey) {
    try {
      const { resolveApiKeyForProvider } =
        await import("openclaw/plugin-sdk/provider-auth-runtime");
      discoveryApiKey = (
        await resolveApiKeyForProvider({
          provider: PROVIDER_ID,
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
  const configured = ctx.config?.models?.providers?.[PROVIDER_ID];
  let observed: ClawRouterCatalogObservation | undefined;
  const canShare =
    !configured?.headers &&
    !configured?.request &&
    !shouldUseEnvHttpProxyForUrl(normalizeClawRouterRootUrl(configured?.baseUrl) + "/v1/catalog");
  const { listClawRouterBasetenDecisionModels } = await import("./decision-baseten-offers.js");
  const capabilityModels = await listClawRouterBasetenDecisionModels(
    {
      config: ctx.config,
      resolveProviderApiKey: () => ({ apiKey, discoveryApiKey }),
    },
    canShare
      ? (page) => {
          observed = page;
        }
      : undefined,
  );
  let provider: Awaited<ReturnType<typeof buildClawRouterProviderConfig>>;
  try {
    provider = await buildClawRouterProviderConfig({
      apiKey,
      discoveryApiKey,
      baseUrl: configured?.baseUrl,
      fetchGuard: observed && withObservedCatalogPage(observed),
    });
  } finally {
    void observed?.response.body?.cancel().catch(() => undefined);
  }
  return {
    provider,
    outcomes: [
      {
        provider: PROVIDER_ID,
        ...(auth.profileId ? { profileId: auth.profileId } : {}),
        status: capabilityModels === undefined ? "unavailable" : "ready",
        capabilityModels,
      },
    ],
  };
}
