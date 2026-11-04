import {
  getCachedLiveProviderModelRows,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ClawRouterCapabilityOffer } from "./capability-offers.js";
import {
  readCatalogDiscoveryRows,
  selectCatalogDiscoveryOffer,
  type CatalogDiscoveryFact,
  type CatalogDiscoveryProvider,
} from "./catalog-discovery-contracts.js";

const CATALOG_REFRESH_MS = 60_000;

// Preserve the common reader/cache lifetime, but this protocol never follows
// redirects or accepts partial/error bodies as an authoritative inventory.
const catalogFetch: LiveModelCatalogFetchGuard = async (params) => {
  params.signal?.throwIfAborted();
  const result = await fetchWithSsrFGuard({
    ...params,
    maxRedirects: 0,
    init: { ...params.init, method: "GET", credentials: "omit", redirect: "error" },
  });
  const { response } = result;
  if (
    response.status !== 200 ||
    response.redirected ||
    result.finalUrl !== params.url ||
    response.headers.has("content-range") ||
    !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/iu.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    try {
      await response.body?.cancel();
    } finally {
      await result.release();
    }
    throw new Error("ClawRouter model discovery requires a complete HTTP 200 JSON response");
  }
  return result;
};

export async function discoverClawRouterModels(params: {
  provider: CatalogDiscoveryProvider;
  offers: readonly ClawRouterCapabilityOffer[];
  apiKey: string;
  profileId?: string;
  signal?: AbortSignal;
}): Promise<readonly CatalogDiscoveryFact[] | undefined> {
  params.signal?.throwIfAborted();
  if (!params.apiKey.trim()) {
    throw new Error("ClawRouter model discovery requires its original proxy key");
  }
  const offer = selectCatalogDiscoveryOffer(params.provider, params.offers);
  if (!offer) {
    return undefined;
  }
  const url = new URL(offer.url);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("ClawRouter model discovery requires its exact declared URL");
  }
  const rows = await getCachedLiveProviderModelRows({
    providerId: "clawrouter",
    endpoint: offer.url,
    apiKey: params.apiKey,
    discoveryApiKey: params.apiKey,
    signal: params.signal,
    fetchGuard: catalogFetch,
    ttlMs: CATALOG_REFRESH_MS,
    cacheKeyParts: [
      "clawrouter-discovery-v1",
      params.provider,
      offer.url,
      offer.routeKind,
      offer.endpoint,
      offer.requestFormat,
      offer.responseFormat,
      params.profileId,
      params.apiKey,
    ],
    // Validation occurs before caching, including rejection of every pagination field.
    // The common acquisition loop therefore cannot turn metadata into another GET.
    readRows: (body) => readCatalogDiscoveryRows(params.provider, body),
    auditContext: "clawrouter-offered-model-discovery",
  });
  params.signal?.throwIfAborted();
  return rows;
}
