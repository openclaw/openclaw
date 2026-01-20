import { buildBlueBubblesApiUrl, blueBubblesFetchWithTimeout } from "./types.js";

export type BlueBubblesProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
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

/** Cache server info to avoid repeated API calls */
const serverInfoCache = new Map<string, { info: BlueBubblesServerInfo; expires: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch server info from BlueBubbles API.
 * Returns cached result if available and not expired.
 */
export async function fetchBlueBubblesServerInfo(params: {
  baseUrl?: string | null;
  password?: string | null;
  timeoutMs?: number;
}): Promise<BlueBubblesServerInfo | null> {
  const baseUrl = params.baseUrl?.trim();
  const password = params.password?.trim();
  if (!baseUrl || !password) return null;

  const cacheKey = `${baseUrl}:${password}`;
  const cached = serverInfoCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.info;
  }

  const url = buildBlueBubblesApiUrl({ baseUrl, path: "/api/v1/server/info", password });
  try {
    const res = await blueBubblesFetchWithTimeout(url, { method: "GET" }, params.timeoutMs ?? 5000);
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const data = payload?.data as BlueBubblesServerInfo | undefined;
    if (data) {
      serverInfoCache.set(cacheKey, { info: data, expires: Date.now() + CACHE_TTL_MS });
    }
    return data ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse macOS version string (e.g., "15.0.1" or "26.0") into major version number.
 */
export function parseMacOSMajorVersion(version?: string | null): number | null {
  if (!version) return null;
  const match = /^(\d+)/.exec(version.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Clear the server info cache (for testing) */
export function clearServerInfoCache(): void {
  serverInfoCache.clear();
}

export async function probeBlueBubbles(params: {
  baseUrl?: string | null;
  password?: string | null;
  timeoutMs?: number;
}): Promise<BlueBubblesProbe> {
  const baseUrl = params.baseUrl?.trim();
  const password = params.password?.trim();
  if (!baseUrl) return { ok: false, error: "serverUrl not configured" };
  if (!password) return { ok: false, error: "password not configured" };
  const url = buildBlueBubblesApiUrl({ baseUrl, path: "/api/v1/ping", password });
  try {
    const res = await blueBubblesFetchWithTimeout(
      url,
      { method: "GET" },
      params.timeoutMs,
    );
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
