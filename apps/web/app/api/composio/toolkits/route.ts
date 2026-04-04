import {
  fetchComposioToolkits,
  type ComposioToolkitsResponse,
  resolveComposioApiKey,
  resolveComposioEligibility,
  resolveComposioGatewayUrl,
} from "@/lib/composio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_TOOLKITS_CACHE_TTL_MS = 5 * 60_000;

type CacheEntry<T> =
  | {
      expiresAt: number;
      value: T;
    }
  | {
      expiresAt: number;
      promise: Promise<T>;
    };

const toolkitsCache = new Map<string, CacheEntry<ComposioToolkitsResponse>>();

async function fetchToolkitsCached(
  gatewayUrl: string,
  apiKey: string,
  cacheKey: string,
  options?: {
    search?: string;
    category?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<ComposioToolkitsResponse> {
  const now = Date.now();
  const cached = toolkitsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    if ("value" in cached) {
      return cached.value;
    }
    return cached.promise;
  }

  const promise = fetchComposioToolkits(gatewayUrl, apiKey, options);
  toolkitsCache.set(cacheKey, {
    expiresAt: now + DEFAULT_TOOLKITS_CACHE_TTL_MS,
    promise,
  });

  try {
    const value = await promise;
    toolkitsCache.set(cacheKey, {
      expiresAt: Date.now() + DEFAULT_TOOLKITS_CACHE_TTL_MS,
      value,
    });
    return value;
  } catch (error) {
    toolkitsCache.delete(cacheKey);
    throw error;
  }
}

export async function GET(request: Request) {
  const apiKey = resolveComposioApiKey();
  if (!apiKey) {
    return Response.json(
      { error: "Dench Cloud API key is required." },
      { status: 403 },
    );
  }

  const eligibility = resolveComposioEligibility();
  if (!eligibility.eligible) {
    return Response.json(
      {
        error: "Dench Cloud must be the primary provider.",
        lockReason: eligibility.lockReason,
        lockBadge: eligibility.lockBadge,
      },
      { status: 403 },
    );
  }

  const { searchParams } = new URL(request.url);
  const gatewayUrl = resolveComposioGatewayUrl();

  try {
    const search = searchParams.get("search") ?? undefined;
    const category = searchParams.get("category") ?? undefined;
    const cursor = searchParams.get("cursor") ?? undefined;
    const limit = searchParams.has("limit")
      ? Number(searchParams.get("limit"))
      : undefined;
    const cacheKey = JSON.stringify({
      gatewayUrl,
      apiKey,
      search: search ?? null,
      category: category ?? null,
      cursor: cursor ?? null,
      limit: limit ?? null,
    });
    const data = await fetchToolkitsCached(gatewayUrl, apiKey, cacheKey, {
      search,
      category,
      cursor,
      limit,
    });
    return Response.json(data);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch toolkits." },
      { status: 502 },
    );
  }
}
