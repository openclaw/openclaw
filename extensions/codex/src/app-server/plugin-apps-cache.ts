import type { v2 } from "./protocol-generated/typescript/index.js";

export type CodexPluginAppsRequest = (method: string, params?: unknown) => Promise<unknown>;

const CODEX_PLUGIN_APPS_CACHE_TTL_MS = 60 * 60_000;
const DEFAULT_CACHE_KEY = "default";

type CodexPluginAppsCacheEntry = {
  apps: v2.AppInfo[];
  expiresAt: number;
  refresh?: Promise<v2.AppInfo[]>;
};

const appsCacheByKey = new Map<string, CodexPluginAppsCacheEntry>();

export async function readCodexPluginAppsCached(params: {
  request: CodexPluginAppsRequest;
  cacheKey?: string;
  forceRefetch?: boolean;
}): Promise<v2.AppInfo[]> {
  const cacheKey = params.cacheKey || DEFAULT_CACHE_KEY;
  const cached = appsCacheByKey.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.apps;
  }
  if (cached) {
    void refreshCodexPluginAppsCache({
      request: params.request,
      cacheKey,
      forceRefetch: params.forceRefetch === true,
      existing: cached,
    }).catch(() => undefined);
    return cached.apps;
  }
  return await refreshCodexPluginAppsCache({
    request: params.request,
    cacheKey,
    forceRefetch: params.forceRefetch === true,
  });
}

export function clearCodexPluginAppsCache(cacheKey?: string): void {
  if (cacheKey) {
    appsCacheByKey.delete(cacheKey);
    return;
  }
  appsCacheByKey.clear();
}

async function refreshCodexPluginAppsCache(params: {
  request: CodexPluginAppsRequest;
  cacheKey: string;
  forceRefetch: boolean;
  existing?: CodexPluginAppsCacheEntry;
}): Promise<v2.AppInfo[]> {
  if (params.existing?.refresh) {
    return await params.existing.refresh;
  }
  const refresh = readAllCodexApps(params.request, { forceRefetch: params.forceRefetch });
  appsCacheByKey.set(params.cacheKey, {
    apps: params.existing?.apps ?? [],
    expiresAt: params.existing?.expiresAt ?? 0,
    refresh,
  });
  try {
    const apps = await refresh;
    appsCacheByKey.set(params.cacheKey, {
      apps,
      expiresAt: Date.now() + CODEX_PLUGIN_APPS_CACHE_TTL_MS,
    });
    return apps;
  } catch (err) {
    if (params.existing) {
      appsCacheByKey.set(params.cacheKey, params.existing);
    } else {
      appsCacheByKey.delete(params.cacheKey);
    }
    throw err;
  }
}

async function readAllCodexApps(
  request: CodexPluginAppsRequest,
  params: Pick<v2.AppsListParams, "forceRefetch">,
): Promise<v2.AppInfo[]> {
  const apps: v2.AppInfo[] = [];
  let cursor: string | null | undefined;
  do {
    const response = (await request("app/list", {
      ...params,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    } satisfies v2.AppsListParams)) as v2.AppsListResponse;
    apps.push(...(response.data ?? []));
    cursor = response.nextCursor;
  } while (cursor);
  return apps;
}
