import type { CodexCatalogAvailability } from "./session-catalog-availability.js";
import {
  encodeCodexResidentCursor,
  type CodexResidentCatalogCursor,
} from "./session-catalog-index-cursor.js";
import type { CodexCatalogField, CodexCatalogStatus } from "./session-catalog-index-field.js";
import {
  compareCodexCatalogRows,
  type CodexCatalogOrderKey,
  type CodexCatalogOrderedRow,
} from "./session-catalog-index-order.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import { normalizeLimit } from "./session-catalog-parsing.js";
import type { CodexCatalogSettingsIndex } from "./session-catalog-settings.js";
import { applyCodexCatalogLiveFields } from "./session-catalog-status.js";
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
    ordered: readonly CodexCatalogOrderedRow[],
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
    function* candidates() {
      for (const { row, searchText } of ordered) {
        if (!complete && frontier && compareCodexCatalogRows(row, frontier) > 0) {
          break;
        }
        if (
          (!cwd || (liveSettings.get(row.threadId)?.cwd ?? row.page.sessions[0]!.cwd) === cwd) &&
          (!search || searchText.includes(search))
        ) {
          yield row;
        }
      }
    }
    let hasPrevious = false;
    const page: CodexCatalogIndexRow[] = [];
    let continuation: CodexCatalogOrderKey | undefined;
    const after = (row: CodexCatalogOrderKey) =>
      !anchor || compareCodexCatalogRows(row, anchor) > 0;
    for (const row of candidates()) {
      if (anchor?.backwards) {
        if (row.threadId === anchor.threadId) {
          continue;
        }
        if (after(row)) {
          break;
        }
        if (page.length === limit) {
          page.shift();
          hasPrevious = true;
        }
      } else if (!after(row)) {
        hasPrevious = true;
        continue;
      } else if (page.length === limit) {
        continuation = page.at(-1);
        break;
      }
      page.push(row);
    }
    if (anchor?.backwards && !page.length) {
      // The preceding page disappeared; keep navigation at the current head.
      hasPrevious = false;
      for (const row of candidates()) {
        page.push(row);
        if (page.length === limit) {
          break;
        }
      }
    }
    const first = page[0];
    const last = page.at(-1);
    if (anchor?.backwards && last) {
      for (const row of candidates()) {
        if (!complete || compareCodexCatalogRows(row, last) > 0) {
          continuation = last;
          break;
        }
      }
    }
    if (!complete && !continuation) {
      if (!anchor?.backwards && !last && (!frontier || !after(frontier))) {
        return undefined;
      }
      continuation =
        frontier && (!last || compareCodexCatalogRows(frontier, last) > 0) ? frontier : last;
    }
    return {
      sessions: page.map((row) =>
        applyCodexCatalogLiveFields(
          row.page.sessions[0]!,
          liveStatus.get(row.threadId),
          liveSettings.get(row.threadId),
        ),
      ),
      ...(continuation ? { nextCursor: cursor(continuation, false) } : {}),
      ...(first && hasPrevious ? { backwardsCursor: cursor(first, true) } : {}),
    };
  };
}
