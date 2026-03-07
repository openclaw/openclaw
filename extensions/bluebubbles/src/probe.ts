import type { BaseProbeResult } from "openclaw/plugin-sdk/bluebubbles";
import { normalizeSecretInputString } from "./secret-input.js";
import { buildBlueBubblesApiUrl, blueBubblesFetchWithTimeout } from "./types.js";

export type BlueBubblesProbe = BaseProbeResult & {
  status?: number | null;
};

export type BlueBubblesServerInfo = {
  os_version?: string;
  server_version?: string;
  private_api?: boolean;
  helper_connected?: boolean;
  proxy_service?: string;
  detected_icloud?: string;
  computer_id?: string;
};

export type BlueBubblesPrivateApiStatusParams = {
  baseUrl?: string | null;
  password?: string | null;
  accountId?: string;
  timeoutMs?: number;
};

/** Cache server info by account ID to avoid repeated API calls.
 * Size-capped to prevent unbounded growth (#4948). */
const MAX_SERVER_INFO_CACHE_SIZE = 64;
const MAX_UNKNOWN_PRIVATE_API_STATUS_CACHE_SIZE = 64;
const serverInfoCache = new Map<string, { info: BlueBubblesServerInfo; expires: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const UNKNOWN_PRIVATE_API_STATUS_TTL_MS = 30_000;
const unknownPrivateApiStatusCache = new Map<string, number>();
const privateApiStatusProbeInflight = new Map<string, Promise<boolean | null>>();

function buildCacheKey(accountId?: string): string {
  return accountId?.trim() || "default";
}

/**
 * Fetch server info from BlueBubbles API and cache it.
 * Returns cached result if available and not expired.
 */
export async function fetchBlueBubblesServerInfo(params: {
  baseUrl?: string | null;
  password?: string | null;
  accountId?: string;
  timeoutMs?: number;
}): Promise<BlueBubblesServerInfo | null> {
  const baseUrl = normalizeSecretInputString(params.baseUrl);
  const password = normalizeSecretInputString(params.password);
  if (!baseUrl || !password) {
    return null;
  }

  const cacheKey = buildCacheKey(params.accountId);
  const cached = serverInfoCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.info;
  }

  const url = buildBlueBubblesApiUrl({ baseUrl, path: "/api/v1/server/info", password });
  try {
    const res = await blueBubblesFetchWithTimeout(url, { method: "GET" }, params.timeoutMs ?? 5000);
    if (!res.ok) {
      return null;
    }
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const data = payload?.data as BlueBubblesServerInfo | undefined;
    if (data) {
      serverInfoCache.set(cacheKey, { info: data, expires: Date.now() + CACHE_TTL_MS });
      // Evict oldest entries if cache exceeds max size
      if (serverInfoCache.size > MAX_SERVER_INFO_CACHE_SIZE) {
        const oldest = serverInfoCache.keys().next().value;
        if (oldest !== undefined) {
          serverInfoCache.delete(oldest);
        }
      }
    }
    return data ?? null;
  } catch {
    return null;
  }
}

/**
 * Get cached server info synchronously (for use in listActions).
 * Returns null if not cached or expired.
 */
export function getCachedBlueBubblesServerInfo(accountId?: string): BlueBubblesServerInfo | null {
  const cacheKey = buildCacheKey(accountId);
  const cached = serverInfoCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.info;
  }
  return null;
}

/**
 * Read cached private API capability for a BlueBubbles account.
 * Returns null when capability is unknown (for example, before first probe).
 */
export function getCachedBlueBubblesPrivateApiStatus(accountId?: string): boolean | null {
  const info = getCachedBlueBubblesServerInfo(accountId);
  if (!info || typeof info.private_api !== "boolean") {
    return null;
  }
  return info.private_api;
}

function hasRecentUnknownPrivateApiStatus(accountId?: string): boolean {
  const cacheKey = buildCacheKey(accountId);
  const expires = unknownPrivateApiStatusCache.get(cacheKey);
  if (expires === undefined) {
    return false;
  }
  if (expires <= Date.now()) {
    unknownPrivateApiStatusCache.delete(cacheKey);
    return false;
  }
  return true;
}

function setUnknownPrivateApiStatus(accountId?: string): void {
  const cacheKey = buildCacheKey(accountId);
  const now = Date.now();
  for (const [key, expires] of unknownPrivateApiStatusCache) {
    if (expires <= now) {
      unknownPrivateApiStatusCache.delete(key);
    }
  }
  if (unknownPrivateApiStatusCache.has(cacheKey)) {
    unknownPrivateApiStatusCache.delete(cacheKey);
  }
  unknownPrivateApiStatusCache.set(cacheKey, now + UNKNOWN_PRIVATE_API_STATUS_TTL_MS);
  while (unknownPrivateApiStatusCache.size > MAX_UNKNOWN_PRIVATE_API_STATUS_CACHE_SIZE) {
    const oldest = unknownPrivateApiStatusCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    unknownPrivateApiStatusCache.delete(oldest);
  }
}

function clearUnknownPrivateApiStatus(accountId?: string): void {
  unknownPrivateApiStatusCache.delete(buildCacheKey(accountId));
}

export async function resolveBlueBubblesPrivateApiStatus(
  params: BlueBubblesPrivateApiStatusParams,
): Promise<boolean | null> {
  const cached = getCachedBlueBubblesPrivateApiStatus(params.accountId);
  if (cached !== null) {
    clearUnknownPrivateApiStatus(params.accountId);
    return cached;
  }
  if (hasRecentUnknownPrivateApiStatus(params.accountId)) {
    return null;
  }
  const cacheKey = buildCacheKey(params.accountId);
  const inflight = privateApiStatusProbeInflight.get(cacheKey);
  if (inflight) {
    return await inflight;
  }
  const probePromise = (async () => {
    const info = await fetchBlueBubblesServerInfo(params);
    const status = typeof info?.private_api === "boolean" ? info.private_api : null;
    if (status === null) {
      // Avoid paying the full probe timeout on every send while the capability remains unknown.
      setUnknownPrivateApiStatus(params.accountId);
    } else {
      clearUnknownPrivateApiStatus(params.accountId);
    }
    return status;
  })();
  privateApiStatusProbeInflight.set(cacheKey, probePromise);
  try {
    return await probePromise;
  } finally {
    privateApiStatusProbeInflight.delete(cacheKey);
  }
}

export function isBlueBubblesPrivateApiStatusEnabled(status: boolean | null): boolean {
  return status === true;
}

export function isBlueBubblesPrivateApiEnabled(accountId?: string): boolean {
  return isBlueBubblesPrivateApiStatusEnabled(getCachedBlueBubblesPrivateApiStatus(accountId));
}

/**
 * Parse macOS version string (e.g., "15.0.1" or "26.0") into major version number.
 */
export function parseMacOSMajorVersion(version?: string | null): number | null {
  if (!version) {
    return null;
  }
  const match = /^(\d+)/.exec(version.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Check if the cached server info indicates macOS 26 or higher.
 * Returns false if no cached info is available (fail open for action listing).
 */
export function isMacOS26OrHigher(accountId?: string): boolean {
  const info = getCachedBlueBubblesServerInfo(accountId);
  if (!info?.os_version) {
    return false;
  }
  const major = parseMacOSMajorVersion(info.os_version);
  return major !== null && major >= 26;
}

/** Clear the server info cache (for testing) */
export function clearServerInfoCache(): void {
  serverInfoCache.clear();
  unknownPrivateApiStatusCache.clear();
  privateApiStatusProbeInflight.clear();
}

export async function probeBlueBubbles(params: {
  baseUrl?: string | null;
  password?: string | null;
  timeoutMs?: number;
}): Promise<BlueBubblesProbe> {
  const baseUrl = normalizeSecretInputString(params.baseUrl);
  const password = normalizeSecretInputString(params.password);
  if (!baseUrl) {
    return { ok: false, error: "serverUrl not configured" };
  }
  if (!password) {
    return { ok: false, error: "password not configured" };
  }
  const url = buildBlueBubblesApiUrl({ baseUrl, path: "/api/v1/ping", password });
  try {
    const res = await blueBubblesFetchWithTimeout(url, { method: "GET" }, params.timeoutMs);
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
