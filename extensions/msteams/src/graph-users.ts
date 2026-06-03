// Msteams plugin module implements graph users behavior.
import { escapeOData, fetchGraphJson, type GraphResponse, type GraphUser } from "./graph.js";

const DEFAULT_PROFILE_CACHE_TTL_MS = 3_600_000; // 1 hour

type CachedProfile = { profile: GraphUser; ts: number };
const profileCache = new Map<string, CachedProfile>();

/** @internal Clear the AAD profile cache (for testing). */
export function clearAadProfileCache(): void {
  profileCache.clear();
}

/**
 * Fetch a user's AAD profile by object ID from Microsoft Graph.
 * Results are cached in-process with a configurable TTL. The cache key
 * includes the tenant ID so multi-tenant bots cannot leak profiles
 * across directories.
 */
export async function fetchAadUserProfile(params: {
  token: string;
  aadObjectId: string;
  tenantId?: string;
  cacheTtlMs?: number;
}): Promise<GraphUser | null> {
  const { token, aadObjectId } = params;
  if (!aadObjectId) {
    return null;
  }

  const cacheKey = params.tenantId ? `${params.tenantId}:${aadObjectId}` : aadObjectId;
  const ttl = params.cacheTtlMs ?? DEFAULT_PROFILE_CACHE_TTL_MS;
  const cached = profileCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ttl) {
    return cached.profile;
  }

  const select = "id,displayName,mail,userPrincipalName,department,jobTitle";
  const path = `/users/${encodeURIComponent(aadObjectId)}?$select=${select}`;
  try {
    const profile = await fetchGraphJson<GraphUser>({ token, path });
    if (profile?.id) {
      profileCache.set(cacheKey, { profile, ts: Date.now() });
      return profile;
    }
  } catch {
    // Graph 404 or permission error — caller handles null.
  }
  return null;
}

export async function searchGraphUsers(params: {
  token: string;
  query: string;
  top?: number;
}): Promise<GraphUser[]> {
  const query = params.query.trim();
  if (!query) {
    return [];
  }

  if (query.includes("@")) {
    const escaped = escapeOData(query);
    const filter = `(mail eq '${escaped}' or userPrincipalName eq '${escaped}')`;
    const path = `/users?$filter=${encodeURIComponent(filter)}&$select=id,displayName,mail,userPrincipalName`;
    const res = await fetchGraphJson<GraphResponse<GraphUser>>({ token: params.token, path });
    return res.value ?? [];
  }

  const top = typeof params.top === "number" && params.top > 0 ? params.top : 10;
  const path = `/users?$search=${encodeURIComponent(`"displayName:${query}"`)}&$select=id,displayName,mail,userPrincipalName&$top=${top}`;
  const res = await fetchGraphJson<GraphResponse<GraphUser>>({
    token: params.token,
    path,
    headers: { ConsistencyLevel: "eventual" },
  });
  return res.value ?? [];
}
