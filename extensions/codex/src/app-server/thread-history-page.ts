import {
  CatalogParamsError,
  parseTranscriptPage,
  readControlCursor,
} from "../session-catalog-parsing.js";
import type {
  CodexThread,
  CodexThreadItem,
  CodexThreadItemsListParams,
  CodexThreadItemsListResponse,
  CodexThreadTurnsListParams,
  CodexThreadTurnsListResponse,
  CodexTurn,
} from "./protocol.js";

export type CodexHistoryItemEntry = {
  turnId: string;
  item: CodexThreadItem;
  turn?: Omit<CodexTurn, "items">;
};
export type CodexHistoryPageRequest = { threadId: string; cursor?: string; limit: number };
export type CodexHistoryPage<T> = { items: T[]; nextCursor?: string };
type HistoryReader = {
  listTurnPage(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResponse>;
  listItemPage(params: CodexThreadItemsListParams): Promise<CodexThreadItemsListResponse>;
};
type HistoryProjection<T> = {
  project(entries: CodexHistoryItemEntry[], limit: number): T[];
  fits(page: CodexHistoryPage<T>): boolean;
};
const TURN_ITEM_CURSOR_PREFIX = "turn-item:";

function encodeTurnItemCursor(turnCursor: string, itemId: string): string {
  return (
    TURN_ITEM_CURSOR_PREFIX +
    Buffer.from(JSON.stringify([turnCursor, itemId])).toString("base64url")
  );
}

function decodeTurnItemCursor(cursor?: string): { turnCursor?: string; itemId?: string } {
  if (!cursor?.startsWith(TURN_ITEM_CURSOR_PREFIX)) {
    return { turnCursor: cursor };
  }
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(cursor.slice(TURN_ITEM_CURSOR_PREFIX.length), "base64url").toString(),
    );
  } catch {
    throw new CatalogParamsError("invalid Codex transcript item cursor");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    !value[0] ||
    typeof value[1] !== "string" ||
    !value[1]
  ) {
    throw new CatalogParamsError("invalid Codex transcript item cursor");
  }
  return { turnCursor: value[0], itemId: value[1] };
}

/** Legacy stores expose only turn cursors; an item identity preserves paging across appends. */
export async function readLegacyCodexHistoryPage<T>(
  readTurns: (
    params: CodexHistoryPageRequest & { sortDirection: "desc"; itemsView: "full" },
  ) => Promise<CodexThreadTurnsListResponse>,
  request: CodexHistoryPageRequest,
  projection: HistoryProjection<T>,
): Promise<CodexHistoryPage<T>> {
  const { turnCursor, itemId } = decodeTurnItemCursor(request.cursor);
  const page = parseTranscriptPage(
    await readTurns({
      threadId: request.threadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "full",
      ...(turnCursor ? { cursor: turnCursor } : {}),
    }),
  );
  const source = page.data.flatMap(({ items, ...turn }) =>
    items.toReversed().map((item) => ({ turnId: turn.id, item, turn })),
  );
  const anchorIndex = itemId ? source.findIndex(({ item }) => item.id === itemId) : -1;
  if (itemId && anchorIndex < 0) {
    throw new CatalogParamsError(
      "Codex transcript changed; refresh the session before loading older items",
    );
  }
  const remaining = source.slice(anchorIndex + 1);
  const items = projection.project(remaining.slice(0, request.limit), request.limit);
  const result = (): CodexHistoryPage<T> => {
    const lastSource = remaining[items.length - 1];
    const partial = lastSource !== undefined && items.length < remaining.length;
    const nativeCursor = partial ? page.backwardsCursor : page.nextCursor;
    const cursor = nativeCursor
      ? partial
        ? encodeTurnItemCursor(nativeCursor, lastSource.item.id)
        : nativeCursor
      : undefined;
    if (partial && !cursor) {
      throw new Error("Codex app-server did not provide a transcript continuation anchor");
    }
    return { items, ...(cursor ? { nextCursor: cursor } : {}) };
  };
  let bounded = result();
  while (!projection.fits(bounded)) {
    if (items.length <= 1) {
      throw new Error("Codex transcript item exceeds the safe response size");
    }
    items.pop();
    bounded = result();
  }
  return bounded;
}

/** Callers authorize the thread; this reader owns native cursor and response-size semantics. */
export async function readCodexThreadHistoryPage<T>(
  control: HistoryReader,
  thread: Pick<CodexThread, "historyMode">,
  request: CodexHistoryPageRequest,
  projection: HistoryProjection<T>,
): Promise<CodexHistoryPage<T>> {
  if (thread.historyMode !== "paginated") {
    return readLegacyCodexHistoryPage(
      (params) => control.listTurnPage(params),
      request,
      projection,
    );
  }
  let limit = request.limit;
  for (;;) {
    const page = await control.listItemPage({
      threadId: request.threadId,
      limit,
      sortDirection: "desc",
      ...(request.cursor ? { cursor: request.cursor } : {}),
    });
    const nextCursor = readControlCursor(page.nextCursor, "transcript next response");
    const items = projection.project(page.data, limit);
    const result = { items, ...(nextCursor ? { nextCursor } : {}) };
    const fittingCount = items.length - (projection.fits(result) ? 0 : 1);
    if (fittingCount === page.data.length) {
      return result;
    }
    if (fittingCount < 1) {
      throw new Error("Codex transcript item exceeds the safe response size");
    }
    // The native cursor must describe exactly the delivered entries. Never slice and retain it.
    limit = fittingCount;
  }
}
