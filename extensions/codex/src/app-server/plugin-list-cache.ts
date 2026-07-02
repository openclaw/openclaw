/**
 * Process-local cache for Codex app-server `plugin/list` responses, keyed by
 * runtime identity. Prevents repeated disk I/O when multiple code paths
 * (plugin inventory, activation, thread config) call `plugin/list` during a
 * single request cycle.
 *
 * See https://github.com/openclaw/openclaw/issues/99071 — without this cache,
 * each `buildCodexPluginThreadConfig` call issues up to 4 `plugin/list` RPCs,
 * and each RPC causes the Codex app-server to scan ~180 `plugin.json` files
 * from disk, producing 1.3–1.4 GB of reads per 30-second window.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isFutureDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { v2 } from "./protocol.js";

/** Default plugin list cache freshness window — shorter than app inventory
 * because plugin install/enable state changes are more disruptive. */
export const CODEX_PLUGIN_LIST_CACHE_TTL_MS = 5 * 60 * 1_000;

/** Request function used to call `plugin/list` on the Codex app-server. */
export type CodexPluginListRequest = (
  method: "plugin/list",
  params: v2.PluginListParams,
) => Promise<v2.PluginListResponse>;

/** Immutable plugin list snapshot returned from cache reads and refreshes. */
export type CodexPluginListSnapshot = {
  key: string;
  response: v2.PluginListResponse;
  fetchedAtMs: number;
  expiresAtMs: number;
  revision: number;
};

/** Freshness state for a cache read. */
export type CodexPluginListReadState = "fresh" | "stale" | "missing";

/** Cache read result. */
export type CodexPluginListCacheRead = {
  state: CodexPluginListReadState;
  key: string;
  revision: number;
  snapshot?: CodexPluginListSnapshot;
};

type CacheEntry = CodexPluginListSnapshot & {
  invalidated: boolean;
};

type RefreshParams = {
  key: string;
  request: CodexPluginListRequest;
  nowMs?: number;
  forceRefetch?: boolean;
};

/** In-memory `plugin/list` cache with coalesced refreshes per key. */
export class CodexPluginListCache {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CodexPluginListSnapshot>>();
  private readonly refreshTokens = new Map<string, number>();
  private revision = 0;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? CODEX_PLUGIN_LIST_CACHE_TTL_MS;
  }

  /** Reads a snapshot, returning freshness state without scheduling refresh. */
  read(params: { key: string; nowMs?: number }): CodexPluginListCacheRead {
    const nowMs = resolveDateTimestampMs(params.nowMs);
    const entry = this.entries.get(params.key);
    if (!entry) {
      return {
        state: "missing",
        key: params.key,
        revision: this.revision,
      };
    }

    const state: CodexPluginListReadState =
      entry.invalidated || !isFutureDateTimestampMs(entry.expiresAtMs, { nowMs })
        ? "stale"
        : "fresh";
    return {
      state,
      key: params.key,
      revision: entry.revision,
      snapshot: stripEntryState(entry),
    };
  }

  /** Forces or joins an immediate refresh for a cache key. */
  refreshNow(params: RefreshParams): Promise<CodexPluginListSnapshot> {
    return this.refresh(params);
  }

  /** Returns a cached fresh snapshot or refreshes if missing/stale. */
  async readOrRefresh(params: RefreshParams): Promise<CodexPluginListSnapshot> {
    const nowMs = resolveDateTimestampMs(params.nowMs);
    const entry = this.entries.get(params.key);
    if (
      entry &&
      !entry.invalidated &&
      isFutureDateTimestampMs(entry.expiresAtMs, { nowMs }) &&
      !params.forceRefetch
    ) {
      return stripEntryState(entry);
    }
    return this.refresh(params);
  }

  /** Marks a key stale and records the reason. */
  invalidate(key: string, _reason: string, nowMs = Date.now()): number {
    this.revision += 1;
    const entry = this.entries.get(key);
    if (entry) {
      entry.invalidated = true;
      entry.revision = this.revision;
    }
    return this.revision;
  }

  /** Clears all cached snapshots and state. */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.refreshTokens.clear();
    this.revision = 0;
  }

  /** Returns the monotonically increasing cache revision. */
  getRevision(): number {
    return this.revision;
  }

  private async refresh(params: RefreshParams): Promise<CodexPluginListSnapshot> {
    const existing = this.inFlight.get(params.key);
    if (existing && !params.forceRefetch) {
      return existing;
    }

    const refreshToken = (this.refreshTokens.get(params.key) ?? 0) + 1;
    this.refreshTokens.set(params.key, refreshToken);
    const promise = this.refreshUncoalesced(params, refreshToken);
    this.inFlight.set(params.key, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(params.key) === promise) {
        this.inFlight.delete(params.key);
      }
    }
  }

  private async refreshUncoalesced(
    params: RefreshParams,
    refreshToken: number,
  ): Promise<CodexPluginListSnapshot> {
    const nowMs = resolveDateTimestampMs(params.nowMs);
    try {
      const response = await params.request("plugin/list", {
        cwds: [],
      } satisfies v2.PluginListParams);
      this.revision += 1;
      const expiresAtMs = resolveExpiresAtMsFromDurationMs(this.ttlMs, { nowMs }) ?? 0;
      const snapshot: CodexPluginListSnapshot = {
        key: params.key,
        response,
        fetchedAtMs: nowMs,
        expiresAtMs,
        revision: this.revision,
      };
      if (this.refreshTokens.get(params.key) === refreshToken) {
        this.entries.set(params.key, { ...snapshot, invalidated: false });
      }
      return snapshot;
    } catch (error) {
      embeddedAgentLog.warn("codex plugin list cache refresh failed", {
        forceRefetch: params.forceRefetch === true,
        key: params.key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

/** Shared plugin list cache used by Codex app-server runtime paths. */
export const defaultCodexPluginListCache = new CodexPluginListCache();

function stripEntryState(entry: CacheEntry): CodexPluginListSnapshot {
  const { invalidated: _invalidated, ...snapshot } = entry;
  return snapshot;
}
