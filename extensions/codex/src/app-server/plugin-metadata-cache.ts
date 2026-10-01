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

type CodexPluginMetadataSnapshot<
  QueryKind extends CodexPluginMetadataQueryKind = CodexPluginMetadataQueryKind,
> = {
  appCacheKey: string;
  queryKind: QueryKind;
  response: CodexPluginMetadataResponse<QueryKind>;
};

type CachedCodexPluginMetadataEntry = {
  snapshot: CodexPluginMetadataSnapshot;
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
  promise: Promise<CodexPluginMetadataSnapshot>;
};

export class CodexPluginMetadataCache {
  private readonly entries = new Map<string, CachedCodexPluginMetadataEntry>();
  private readonly inFlight = new Map<string, InFlightCodexPluginMetadataLoad>();
  private readonly generations = new Map<string, number>();
  private clearGeneration = 0;

  constructor(private readonly nowMs: () => number = Date.now) {}

  read<QueryKind extends CodexPluginMetadataQueryKind>(
    appCacheKey: string,
    queryKind: QueryKind,
    requestParams?: CodexPluginMetadataRequestParams<QueryKind>,
    catalogScope?: string,
  ): CodexPluginMetadataSnapshot<QueryKind> | undefined {
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
    return entry.snapshot as CodexPluginMetadataSnapshot<QueryKind>;
  }

  /** Returns a fresh snapshot or coalesces one catalog or installed-plugin request. */
  async load<QueryKind extends CodexPluginMetadataQueryKind>(
    params: LoadCodexPluginMetadataParams<QueryKind>,
  ): Promise<CodexPluginMetadataSnapshot<QueryKind>> {
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
      try {
        return (await pending.promise) as CodexPluginMetadataSnapshot<QueryKind>;
      } catch {
        if (this.inFlight.get(entryKey) === pending) {
          this.inFlight.delete(entryKey);
        }
        return await this.load(params);
      }
    }

    const generation = this.generations.get(params.appCacheKey) ?? 0;
    const clearGeneration = this.clearGeneration;
    const promise = (async () => {
      const method = (
        params.queryKind === "installed" ? "plugin/installed" : "plugin/list"
      ) as CodexPluginMetadataMethod<QueryKind>;
      const response = await params.request(method, params.requestParams);
      const snapshot = {
        appCacheKey: params.appCacheKey,
        queryKind: params.queryKind,
        response,
      } satisfies CodexPluginMetadataSnapshot<QueryKind>;
      // Settled snapshots survive until install invalidation, identity change,
      // TTL expiry, restart, or test reset — never a per-turn refresh.
      if (
        generation === (this.generations.get(params.appCacheKey) ?? 0) &&
        clearGeneration === this.clearGeneration &&
        response.marketplaceLoadErrors.length === 0 &&
        (params.cacheable?.(response) ?? true)
      ) {
        this.entries.set(entryKey, {
          snapshot,
          expiresAtMs: this.nowMs() + CODEX_PLUGIN_METADATA_CACHE_TTL_MS,
        });
      }
      return snapshot;
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
    this.generations.set(appCacheKey, (this.generations.get(appCacheKey) ?? 0) + 1);
    for (const [entryKey, entry] of this.entries) {
      if (entry.snapshot.appCacheKey === appCacheKey) {
        this.entries.delete(entryKey);
      }
    }
    for (const [entryKey, pending] of this.inFlight) {
      if (pending.appCacheKey === appCacheKey) {
        this.inFlight.delete(entryKey);
      }
    }
  }

  /** Clears snapshots and prevents late in-flight loads from repopulating them. */
  clear(): void {
    this.clearGeneration += 1;
    this.generations.clear();
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
  if (queryKind !== "installed") {
    const listParams = requestParams as v2.PluginListParams | undefined;
    // Repository marketplaces are scoped to the supplied roots, while explicit
    // marketplace kinds select different remote catalogs. Sharing either
    // snapshot across requests could expose another workspace's plugins.
    const entry = [
      appCacheKey,
      queryKind,
      listParams?.cwds ?? [],
      Array.from(new Set(listParams?.marketplaceKinds ?? [])).toSorted(),
      ...(catalogScope ? [catalogScope] : []),
    ];
    return JSON.stringify(entry);
  }
  const installedParams = requestParams as v2.PluginInstalledParams | undefined;
  // Codex discovers workspace marketplaces from these exact roots. Reusing one
  // runtime's installed snapshot for another cwd exposes the wrong plugins.
  return JSON.stringify([
    appCacheKey,
    queryKind,
    installedParams?.cwds ?? [],
    Array.from(new Set(installedParams?.installSuggestionPluginNames ?? [])).toSorted(),
  ]);
}
