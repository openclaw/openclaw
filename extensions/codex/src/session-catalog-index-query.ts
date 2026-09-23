import type { CodexCatalogAvailability } from "./session-catalog-availability.js";
import {
  encodeCodexResidentCursor,
  type CodexResidentCatalogCursor,
} from "./session-catalog-index-cursor.js";
import type { CodexCatalogField, CodexCatalogStatus } from "./session-catalog-index-field.js";
import {
  compareCodexCatalogRows,
  type CodexCatalogOrderKey,
} from "./session-catalog-index-order.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import { normalizeLimit } from "./session-catalog-parsing.js";
import type { CodexCatalogSettingsIndex } from "./session-catalog-settings.js";
import type {
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

/** Keyset pagination remains valid when the anchor row is archived or deleted. */
export function prepareCodexCatalogQuery(
  params: CodexSessionCatalogPageParams,
  prepared: CodexResidentCatalogCursor,
) {
  const limit = Math.min(normalizeLimit(params.limit, "limit"), 64);
  const cwd = params.cwd?.trim();
  const search = params.searchTerm?.trim().toLocaleLowerCase();
  const { queryId, anchor } = prepared;
  const cursor = (row: CodexCatalogOrderKey, backwards: boolean) =>
    encodeCodexResidentCursor(queryId, row, backwards);
  return (
    ordered: readonly CodexCatalogIndexRow[],
    liveStatus: Pick<CodexCatalogField<CodexCatalogStatus>, "get">,
    liveSettings: Pick<CodexCatalogSettingsIndex, "get">,
    availability: Pick<CodexCatalogAvailability, "complete" | "frontier">,
  ): CodexSessionCatalogPage | undefined => {
    const { complete, frontier } = availability;
    if (!complete && !frontier) {
      return undefined;
    }
    if (
      !complete &&
      frontier &&
      anchor?.backwards &&
      compareCodexCatalogRows(frontier, anchor) < 0
    ) {
      return undefined;
    }
    const candidates =
      complete && !cwd && !search
        ? ordered
        : ordered.filter((row) => {
            const session = row.page.sessions[0];
            return (
              session &&
              (complete || !frontier || compareCodexCatalogRows(row, frontier) <= 0) &&
              (!cwd || (liveSettings.get(row.threadId)?.cwd ?? session.cwd) === cwd) &&
              (!search ||
                (session.name ?? session.fallbackName)?.toLocaleLowerCase().includes(search))
            );
          });
    const selected = anchor?.backwards
      ? candidates.filter((row) => row.threadId !== anchor.threadId)
      : candidates;
    let start = 0;
    let end: number | undefined;
    const after = (row: CodexCatalogOrderKey) =>
      !anchor || compareCodexCatalogRows(row, anchor) > 0;
    if (anchor) {
      const at = selected.findIndex(after);
      const boundary = at < 0 ? selected.length : at;
      if (anchor.backwards) {
        end = boundary;
        start = Math.max(0, boundary - limit);
      } else {
        start = boundary;
      }
    }
    let page = selected.slice(start, end ?? start + limit);
    if (anchor?.backwards && !page.length) {
      // The preceding page disappeared; keep navigation at the current head.
      start = 0;
      page = candidates.slice(0, limit);
    }
    const first = page[0];
    const last = page.at(-1);
    let continuation: CodexCatalogOrderKey | undefined =
      last &&
      (anchor?.backwards
        ? !complete || candidates.some((row) => compareCodexCatalogRows(row, last) > 0)
        : start + page.length < selected.length)
        ? last
        : undefined;
    if (!complete && !continuation) {
      if (!anchor?.backwards && !last && (!frontier || !after(frontier))) {
        return undefined;
      }
      continuation =
        frontier && (!last || compareCodexCatalogRows(frontier, last) > 0) ? frontier : last;
    }
    return {
      sessions: page.flatMap((row) =>
        row.page.sessions.map(
          ({ status: _storedStatus, activeFlags: _storedFlags, ...session }) => {
            const live = liveStatus.get(row.threadId);
            return {
              ...session,
              ...liveSettings.get(row.threadId),
              status: live?.status ?? "notLoaded",
              ...(live?.activeFlags ? { activeFlags: [...live.activeFlags] } : {}),
            };
          },
        ),
      ),
      ...(continuation ? { nextCursor: cursor(continuation, false) } : {}),
      ...(first && start > 0 ? { backwardsCursor: cursor(first, true) } : {}),
    };
  };
}
