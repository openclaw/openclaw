import type { v2 } from "./protocol.js";

// Matches the sibling app-inventory cache window: upstream refreshes its remote
// catalog in the background, so settled negatives must expire rather than deny
// a configured plugin for the whole process lifetime.
const CODEX_PLUGIN_METADATA_CACHE_TTL_MS = 60 * 60 * 1_000;

export type CodexPluginMetadataQueryKind = "curated-global" | "installed";

type CodexPluginMetadataMethod<QueryKind extends CodexPluginMetadataQueryKind> =
  QueryKind extends "installed" ? "plugin/installed" : "plugin/list";

type CodexPluginMetadataRequestParams<QueryKind extends CodexPluginMetadataQueryKind> =
  QueryKind extends "installed" ? v2.PluginInstalledParams : v2.PluginListParams;

type CodexPluginMetadataResponse<QueryKind extends CodexPluginMetadataQueryKind> =
  QueryKind extends "installed" ? v2.PluginInstalledResponse : v2.PluginListResponse;

type CodexPluginMetadataRequest<QueryKind extends CodexPluginMetadataQueryKind> = (
  method: CodexPluginMetadataMethod<QueryKind>,
  params: CodexPluginMetadataRequestParams<QueryKind>,
) => Promise<CodexPluginMetadataResponse<QueryKind>>;

type CachedCodexPluginMetadataEntry = {
  appCacheKey: string;
  response: v2.PluginInstalledResponse | v2.PluginListResponse;
  expiresAtMs: number;
};

type LoadCodexPluginMetadataParams<QueryKind extends CodexPluginMetadataQueryKind> = {
  appCacheKey: string;
  queryKind: QueryKind;
  requestParams: CodexPluginMetadataRequestParams<QueryKind>;
  catalogScope?: string;
  request: CodexPluginMetadataRequest<QueryKind>;
  /**
   * Guards against fail-open responses: upstream plugin/list only warns when a
   * remote catalog fetch fails with omitted marketplaceKinds, returning local
   * marketplaces with empty marketplaceLoadErrors. Such a snapshot must not
   * settle for the process lifetime, or configured plugins never recover.
   */
  cacheable?: (response: CodexPluginMetadataResponse<QueryKind>) => boolean;
};

type InFlightCodexPluginMetadataLoad = {
  appCacheKey: string;
  promise: Promise<v2.PluginInstalledResponse | v2.PluginListResponse>;
};

export class CodexPluginMetadataCache {
  private readonly entries = new Map<string, CachedCodexPluginMetadataEntry>();
  private readonly inFlight = new Map<string, InFlightCodexPluginMetadataLoad>();

  constructor(private readonly nowMs: () => number = Date.now) {}

  read<QueryKind extends CodexPluginMetadataQueryKind>(
    appCacheKey: string,
    queryKind: QueryKind,
    requestParams?: CodexPluginMetadataRequestParams<QueryKind>,
    catalogScope?: string,
  ): CodexPluginMetadataResponse<QueryKind> | undefined {
    const entryKey = buildMetadataCacheEntryKey(
      appCacheKey,
      queryKind,
      requestParams,
      catalogScope,
    );
    const entry = this.entries.get(entryKey);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAtMs <= this.nowMs()) {
      this.entries.delete(entryKey);
      return undefined;
    }
    // The entry key binds the runtime, query kind, and installed request scope.
    return entry.response as CodexPluginMetadataResponse<QueryKind>;
  }

  /** Returns a fresh snapshot or coalesces one catalog or installed-plugin request. */
  async load<QueryKind extends CodexPluginMetadataQueryKind>(
    params: LoadCodexPluginMetadataParams<QueryKind>,
  ): Promise<CodexPluginMetadataResponse<QueryKind>> {
    const entryKey = buildMetadataCacheEntryKey(
      params.appCacheKey,
      params.queryKind,
      params.requestParams,
      params.catalogScope,
    );
    const cached = this.read(
      params.appCacheKey,
      params.queryKind,
      params.requestParams,
      params.catalogScope,
    );
    if (cached) {
      return cached;
    }
    const pending = this.inFlight.get(entryKey);
    if (pending) {
      return (await pending.promise) as CodexPluginMetadataResponse<QueryKind>;
    }

    const promise = (async () => {
      const method = (
        params.queryKind === "installed" ? "plugin/installed" : "plugin/list"
      ) as CodexPluginMetadataMethod<QueryKind>;
      const response = await params.request(method, params.requestParams);
      // Invalidation during a load is best effort: a late snapshot may survive
      // until the next invalidation or TTL expiry. This cache grants no authority.
      if (response.marketplaceLoadErrors.length === 0 && (params.cacheable?.(response) ?? true)) {
        this.entries.set(entryKey, {
          appCacheKey: params.appCacheKey,
          response,
          expiresAtMs: this.nowMs() + CODEX_PLUGIN_METADATA_CACHE_TTL_MS,
        });
      }
      return response;
    })();
    this.inFlight.set(entryKey, { appCacheKey: params.appCacheKey, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(entryKey)?.promise === promise) {
        this.inFlight.delete(entryKey);
      }
    }
  }

  invalidate(appCacheKey: string): void {
    for (const cache of [this.entries, this.inFlight]) {
      for (const [entryKey, entry] of cache) {
        if (entry.appCacheKey === appCacheKey) {
          cache.delete(entryKey);
        }
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }
}

export const defaultCodexPluginMetadataCache = new CodexPluginMetadataCache();

function buildMetadataCacheEntryKey(
  appCacheKey: string,
  queryKind: CodexPluginMetadataQueryKind,
  requestParams?: v2.PluginListParams | v2.PluginInstalledParams,
  catalogScope?: string,
): string {
  // Workspace roots, catalog kinds, and install suggestions each scope discovery.
  const names =
    queryKind === "installed"
      ? (requestParams as v2.PluginInstalledParams | undefined)?.installSuggestionPluginNames
      : (requestParams as v2.PluginListParams | undefined)?.marketplaceKinds;
  return JSON.stringify([
    appCacheKey,
    queryKind,
    requestParams?.cwds ?? [],
    Array.from(new Set(names ?? [])).toSorted(),
    ...(queryKind !== "installed" && catalogScope ? [catalogScope] : []),
  ]);
}
