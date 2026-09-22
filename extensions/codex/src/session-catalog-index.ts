import { setImmediate as nextTurn } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildCodexAppServerConnectionFingerprint } from "./app-server/plugin-app-cache-key.js";
import type { CodexThreadListParams } from "./app-server/protocol.js";
import { normalizeLimit, readControlCursor } from "./session-catalog-parsing.js";
import type {
  CodexCatalogHome,
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

const CODEX_CATALOG_NATIVE_PAGE_LIMIT = 64;
export const CODEX_CATALOG_CACHE_TTL_MS = 32_000;
export const CODEX_SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES = 32;
const MAX_NATIVE_PAGES_PER_REFRESH = 16;
const HEAD_REFRESH_INTERVAL = 10;

export type CodexCatalogIndexRow = {
  threadId: string;
  updatedAt: number | null;
  recencyAt: number | null;
  page: CodexSessionCatalogPage;
};
type NativePage = {
  rows: CodexCatalogIndexRow[];
  nextCursor?: string;
  backwardsCursor?: string;
};
export type CodexCatalogIndexRead = (params: CodexThreadListParams) => Promise<NativePage>;
type Head = {
  native: NativePage;
  page: CodexSessionCatalogPage;
  refreshedAt: number;
  probes: number;
};
type Query = {
  rows: Map<string, CodexCatalogIndexRow>;
  head?: Head;
  stale?: boolean;
  pending: Map<string, Promise<CodexSessionCatalogPage>>;
};

function catalogPage(native: NativePage): CodexSessionCatalogPage {
  const managedThreads = native.rows.flatMap((row) => row.page.managedThreads ?? []);
  return {
    sessions: native.rows.flatMap((row) => row.page.sessions),
    ...(managedThreads.length ? { managedThreads } : {}),
    ...(native.nextCursor ? { nextCursor: native.nextCursor } : {}),
    ...(native.backwardsCursor ? { backwardsCursor: native.backwardsCursor } : {}),
  };
}

function unchanged(previous: CodexCatalogIndexRow | undefined, row: CodexCatalogIndexRow) {
  // Names and runtime status can change without advancing the native timestamp.
  return (
    previous?.updatedAt === row.updatedAt &&
    previous.recencyAt === row.recencyAt &&
    isDeepStrictEqual(previous.page, row.page)
  );
}

/** Lazily remembers native ordered pages; membership and continuation remain native-owned. */
export class CodexCatalogIndex {
  private readonly queries = new Map<string, Query>();

  constructor(
    private readonly now: () => number,
    private readonly cwd: string | undefined,
    private readonly onSettled: () => void,
  ) {}

  hasPendingWork(): boolean {
    for (const query of this.queries.values()) {
      if (query.pending.size) {
        return true;
      }
    }
    return false;
  }

  private async produce(
    query: Query,
    params: CodexThreadListParams,
    read: CodexCatalogIndexRead,
  ): Promise<CodexSessionCatalogPage> {
    const prior = query.head;
    if (params.cursor || !prior) {
      const native = await read(params);
      for (const row of native.rows) {
        query.rows.set(row.threadId, row);
      }
      pruneMapToMaxSize(
        query.rows,
        CODEX_CATALOG_NATIVE_PAGE_LIMIT * CODEX_SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES,
      );
      const page = catalogPage(native);
      if (!params.cursor) {
        query.head = { native, page, refreshedAt: this.now(), probes: 0 };
      }
      return page;
    }

    const first = prior.native.rows[0];
    const second = prior.native.rows[1];
    // A distinct newest second lets an unchanged one-row probe reuse the page.
    // Tied heads need the full page and overlap, since API timestamps expose only seconds.
    if (
      prior.probes < HEAD_REFRESH_INTERVAL - 1 &&
      first?.recencyAt != null &&
      second?.recencyAt != null &&
      first.recencyAt > second.recencyAt
    ) {
      const probe = await read({ ...params, limit: 1 });
      const candidate = probe.rows[0];
      if (probe.rows.length === 1 && candidate && unchanged(first, candidate)) {
        const page = { ...prior.page };
        query.head = { ...prior, page, refreshedAt: this.now(), probes: prior.probes + 1 };
        return page;
      }
    }

    const previousHead = new Map<string, CodexCatalogIndexRow>();
    for (const row of prior.native.rows) {
      previousHead.set(row.threadId, row);
    }
    const started = performance.now();
    const changed = new Map<string, CodexCatalogIndexRow>();
    const remaining = new Map(query.rows);
    let oldestRecencyAt: number | undefined;
    for (const row of remaining.values()) {
      if (row.recencyAt === null) {
        oldestRecencyAt = undefined;
        break;
      }
      oldestRecencyAt = Math.min(oldestRecencyAt ?? Infinity, row.recencyAt);
    }
    const cursors = new Set<string>();
    const head = await read(params);
    let native = head;
    let overlap = false;
    let exhausted = false;
    let lastRecencyAt: number | null = null;
    for (let i = 0; i < MAX_NATIVE_PAGES_PER_REFRESH; i++) {
      const stable =
        native.rows.length > 0 &&
        native.rows.every((row) =>
          unchanged(query.rows.get(row.threadId) ?? previousHead.get(row.threadId), row),
        );
      for (const row of native.rows) {
        changed.set(row.threadId, row);
        remaining.delete(row.threadId);
      }
      lastRecencyAt = native.rows.at(-1)?.recencyAt ?? null;
      const cursor = native.nextCursor;
      exhausted = !cursor;
      if (!cursor || overlap || (!stable && remaining.size === 0)) {
        break;
      }
      if (cursors.has(cursor) || cursor === params.cursor) {
        throw new Error("Codex session catalog returned a repeated refresh cursor");
      }
      // Stop at the visited prefix; older inventory stays reachable through native cursors.
      if (
        !stable &&
        lastRecencyAt !== null &&
        oldestRecencyAt !== undefined &&
        lastRecencyAt < oldestRecencyAt
      ) {
        break;
      }
      overlap = stable;
      cursors.add(cursor);
      if (
        i + 1 === MAX_NATIVE_PAGES_PER_REFRESH ||
        (!overlap && performance.now() - started >= 1_000)
      ) {
        break;
      }
      await nextTurn();
      native = await read({ ...params, cursor });
    }
    // Publish only after the walked pages settle. Failure leaves the old watermark retryable.
    for (const [id, row] of remaining) {
      if (
        exhausted ||
        (lastRecencyAt !== null && row.recencyAt !== null && row.recencyAt > lastRecencyAt)
      ) {
        query.rows.delete(id);
      }
    }
    for (const [id, row] of changed) {
      query.rows.set(id, row);
    }
    pruneMapToMaxSize(
      query.rows,
      CODEX_CATALOG_NATIVE_PAGE_LIMIT * CODEX_SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES,
    );
    const page = catalogPage(head);
    query.head = { native: head, page, refreshedAt: this.now(), probes: 0 };
    return page;
  }

  async list(
    params: CodexSessionCatalogPageParams,
    read: CodexCatalogIndexRead,
  ): Promise<CodexSessionCatalogPage> {
    const limit = Math.min(normalizeLimit(params.limit, "limit"), CODEX_CATALOG_NATIVE_PAGE_LIMIT);
    const cursor = readControlCursor(params.cursor, "request");
    const key = String(limit);
    let query = this.queries.get(key);
    if (!query) {
      query = { rows: new Map(), pending: new Map() };
      this.queries.set(key, query);
    }
    this.queries.delete(key);
    this.queries.set(key, query);
    for (const [oldKey, old] of this.queries) {
      if (this.queries.size <= CODEX_SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES) {
        break;
      }
      if (oldKey !== key && old.pending.size === 0) {
        this.queries.delete(oldKey);
      }
    }
    const pendingKey = cursor ?? "";
    const pending = query.pending.get(pendingKey);
    if (pending) {
      return await pending;
    }
    if (
      !cursor &&
      !query.stale &&
      query.head &&
      query.head.refreshedAt + CODEX_CATALOG_CACHE_TTL_MS > this.now()
    ) {
      return query.head.page;
    }
    if (!cursor) {
      query.stale = true;
    }
    const page = this.produce(
      query,
      {
        archived: false,
        modelProviders: [],
        sortKey: "recency_at",
        sortDirection: "desc",
        limit,
        ...(cursor ? { cursor } : {}),
        ...(this.cwd ? { cwd: this.cwd } : {}),
      },
      read,
    )
      .then((value) => {
        if (!cursor) {
          query.stale = false;
        }
        return value;
      })
      .finally(() => {
        query.pending.delete(pendingKey);
        this.onSettled();
        for (const [oldKey, old] of this.queries) {
          if (this.queries.size <= CODEX_SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES) {
            break;
          }
          if (old.pending.size === 0) {
            this.queries.delete(oldKey);
          }
        }
      });
    query.pending.set(pendingKey, page);
    return await page;
  }
}

function pruneIndexes(indexes: Map<string, CodexCatalogIndex>, protectedIndex?: CodexCatalogIndex) {
  for (const [key, index] of indexes) {
    if (indexes.size <= CODEX_SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES) {
      break;
    }
    if (index !== protectedIndex && !index.hasPendingWork()) {
      indexes.delete(key);
    }
  }
}

export function createCodexCatalogIndexResolver(params: { now: () => number }) {
  const indexes = new WeakMap<OpenClawConfig, Map<string, Map<string, CodexCatalogIndex>>>();
  const noConfig: OpenClawConfig = {};
  return (
    agentId: string | undefined,
    source:
      | (Pick<CodexCatalogHome, "sourceHomeId"> & Partial<Pick<CodexCatalogHome, "agentDir">>)
      | undefined,
    runtime: CodexCatalogHome["appServer"],
    config: OpenClawConfig = noConfig,
    cwd?: string,
  ) => {
    let bySource = indexes.get(config);
    if (!bySource) {
      bySource = new Map();
      indexes.set(config, bySource);
    }
    const sourceKey = JSON.stringify([
      agentId,
      source?.sourceHomeId,
      buildCodexAppServerConnectionFingerprint(runtime, source?.agentDir),
    ]);
    let byCwd = bySource.get(sourceKey);
    if (!byCwd) {
      byCwd = new Map();
      bySource.set(sourceKey, byCwd);
    }
    const cwdIndexes = byCwd;
    const key = cwd?.trim() || "";
    let index = cwdIndexes.get(key);
    if (!index) {
      index = new CodexCatalogIndex(params.now, key || undefined, () => pruneIndexes(cwdIndexes));
    }
    cwdIndexes.delete(key);
    cwdIndexes.set(key, index);
    pruneIndexes(cwdIndexes, index);
    return index;
  };
}
