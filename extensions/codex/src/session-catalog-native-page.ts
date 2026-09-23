import { setImmediate as nextTurn } from "node:timers/promises";
import type { CodexThreadListParams } from "./app-server/protocol.js";
import type { CodexCatalogIndexOptions } from "./session-catalog-index-contract.js";
import {
  encodeCodexNativeCursor,
  type CodexNativeCatalogCursor,
  type CodexResidentCatalogCursor,
} from "./session-catalog-index-cursor.js";
import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-limits.js";
import type { CodexCatalogListRequest } from "./session-catalog-list-request.js";
import { CODEX_CATALOG_NATIVE_PAGE_LIMIT } from "./session-catalog-native-projection.js";
import {
  CatalogParamsError,
  filterCatalogPageByTitle,
  normalizeLimit,
  readControlCursor,
} from "./session-catalog-parsing.js";
import type { CodexCatalogSettingsIndex } from "./session-catalog-settings.js";
import type { CodexCatalogStatusIndex } from "./session-catalog-status.js";
import type {
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

/** Background walks share bounded native pages; the index decides when a prefix is current. */
export async function* readCodexCatalogHydrationPages<
  T extends { rows: readonly unknown[]; nextCursor?: string },
>(
  read: (params: CodexThreadListParams, remainingRows: number) => Promise<T>,
  useStateDbOnly: boolean,
) {
  let cursor: string | undefined;
  let offset = 0;
  const cursors = new Set<string>();
  do {
    const page = await read(
      {
        archived: false,
        modelProviders: [],
        sortKey: "recency_at",
        sortDirection: "desc",
        limit: CODEX_CATALOG_NATIVE_PAGE_LIMIT,
        ...(useStateDbOnly ? { useStateDbOnly } : {}),
        ...(cursor ? { cursor } : {}),
      },
      Math.max(0, CODEX_CATALOG_MAX_ROWS - offset),
    );
    cursor = readControlCursor(page.nextCursor, "hydration response");
    if (cursor && cursors.has(cursor)) {
      throw new Error("Codex catalog repeated a hydration cursor");
    }
    if (cursor) {
      cursors.add(cursor);
      if (cursors.size > CODEX_CATALOG_MAX_ROWS) {
        cursors.delete(cursors.values().next().value!);
      }
    }
    yield { ...page, nextCursor: cursor, offset };
    offset += page.rows.length;
    await nextTurn();
  } while (cursor);
}

/** The resident limit bounds storage, never authoritative discovery. */
export class CodexCatalogNativePages {
  constructor(
    private readonly settings: CodexCatalogSettingsIndex,
    private readonly status: CodexCatalogStatusIndex,
  ) {}

  async list(
    params: CodexSessionCatalogPageParams,
    prepared: CodexResidentCatalogCursor | CodexNativeCatalogCursor,
    options: Pick<CodexCatalogIndexOptions, "readNative" | "assertCurrent">,
    request: CodexCatalogListRequest,
  ): Promise<CodexSessionCatalogPage> {
    const limit = Math.min(normalizeLimit(params.limit, "limit"), 64);
    const cwd = params.cwd?.trim();
    let position: CodexNativeCatalogCursor =
      prepared.kind === "native"
        ? prepared
        : {
            kind: "native",
            queryId: prepared.queryId,
            backwards: prepared.anchor?.backwards ?? false,
            ...(prepared.anchor ? { anchorThreadId: prepared.anchor.threadId } : {}),
          };
    const at = (
      cursor: string | undefined,
      backwards: boolean,
      anchorThreadId?: string,
    ): CodexNativeCatalogCursor => ({
      kind: "native",
      queryId: prepared.queryId,
      backwards,
      ...(cursor ? { cursor } : {}),
      ...(anchorThreadId ? { anchorThreadId } : {}),
    });
    while (request.hasPages) {
      options.assertCurrent();
      // Native backwards cursors reverse sortDirection. A transition inside a page
      // instead refetches that descending page and locates its frozen thread identity.
      const filterCwdLocally = Boolean(cwd && this.settings.hasLiveCwd());
      const ascending = position.backwards && !position.anchorThreadId;
      const pageLimit = position.anchorThreadId ? 64 : limit;
      const statusRevision = this.status.capture();
      const page = await request.read(Number.POSITIVE_INFINITY, () =>
        options.readNative(
          {
            archived: false,
            modelProviders: [],
            useStateDbOnly: true,
            sortKey: "recency_at",
            sortDirection: ascending ? "asc" : "desc",
            limit: pageLimit,
            ...(cwd && !filterCwdLocally ? { cwd } : {}),
            ...(position.cursor ? { cursor: position.cursor } : {}),
          },
          pageLimit,
          request,
        ),
      );
      options.assertCurrent();
      for (const row of page.rows) {
        this.status.observe(row, statusRevision);
      }
      if (cwd && !filterCwdLocally && this.settings.hasLiveCwd()) {
        continue;
      }
      let rows = ascending ? page.rows.toReversed() : page.rows;
      let next = (ascending ? page.backwardsCursor : page.nextCursor)
        ? at(ascending ? page.backwardsCursor : page.nextCursor, false)
        : undefined;
      let previous = (ascending ? page.nextCursor : page.backwardsCursor)
        ? at(ascending ? page.nextCursor : page.backwardsCursor, true)
        : undefined;
      if (position.anchorThreadId) {
        const anchor = rows.findIndex((row) => row.threadId === position.anchorThreadId);
        if (anchor < 0) {
          if (!page.nextCursor || page.nextCursor === position.cursor) {
            throw new CatalogParamsError(
              "Codex catalog changed; refresh before continuing this page",
            );
          }
          position = at(page.nextCursor, position.backwards, position.anchorThreadId);
          continue;
        }
        const start = position.backwards ? Math.max(0, anchor - limit) : anchor + 1;
        const end = position.backwards ? anchor : Math.min(rows.length, start + limit);
        const selected = rows.slice(start, end);
        if (!selected.length) {
          const continuation = position.backwards ? previous : next;
          if (continuation) {
            position = continuation;
            continue;
          }
        }
        const first = selected[0];
        const last = selected.at(-1);
        if (first && last) {
          next = end < rows.length ? at(position.cursor, false, last.threadId) : next;
          previous = start > 0 ? at(position.cursor, true, first.threadId) : previous;
        }
        rows = selected;
      } else if (!position.cursor && !position.backwards) {
        previous = undefined;
      }
      const projected = filterCatalogPageByTitle(
        {
          sessions: rows
            .flatMap((row) => row.page.sessions)
            .map(({ status: _storedStatus, activeFlags: _storedFlags, ...session }) => {
              const live = this.status.get(session.threadId);
              return Object.assign(session, this.settings.get(session.threadId), {
                status: live?.status ?? "notLoaded",
                ...(live?.activeFlags ? { activeFlags: [...live.activeFlags] } : {}),
              });
            })
            .filter((session) => !cwd || session.cwd === cwd),
        },
        params.searchTerm,
      );
      const continuation = position.backwards ? previous : next;
      if ((params.searchTerm || filterCwdLocally) && !projected.sessions.length && continuation) {
        if (encodeCodexNativeCursor(continuation) === encodeCodexNativeCursor(position)) {
          throw new CatalogParamsError("Codex catalog repeated a native continuation");
        }
        position = continuation;
        continue;
      }
      const managedThreads = rows.flatMap((row) => row.page.managedThreads ?? []);
      return {
        ...projected,
        ...(managedThreads.length ? { managedThreads } : {}),
        ...(next ? { nextCursor: encodeCodexNativeCursor(next) } : {}),
        ...(previous ? { backwardsCursor: encodeCodexNativeCursor(previous) } : {}),
      };
    }
    const continuation = encodeCodexNativeCursor(position);
    return {
      sessions: [],
      ...(position.backwards ? { backwardsCursor: continuation } : { nextCursor: continuation }),
    };
  }
}
