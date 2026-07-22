type SlackCursorResponse = {
  response_metadata?: { next_cursor?: string };
};

/** Maximum cursor pages before the safety backstop is triggered. */
const SLACK_CURSOR_PAGES_MAX = 10_000;

/**
 * Error thrown when Slack cursor pagination enters a cycle (same cursor value
 * returned twice), or when the safety page limit is exceeded with all cursors
 * unique.
 */
class SlackCursorCycleError extends Error {
  override readonly name = "SlackCursorCycleError";
  readonly pageCount: number;
  readonly cursor: string;

  constructor(pageCount: number, cursor: string) {
    const message =
      cursor === ""
        ? `Slack cursor pagination exceeded ${SLACK_CURSOR_PAGES_MAX} pages; all cursors advanced but pagination did not terminate. Data may be incomplete.`
        : `Slack cursor pagination cycle detected after ${pageCount} pages; cursor "${cursor}" was repeated, indicating non-advancing pagination. Data may be incomplete.`;
    super(message);
    this.pageCount = pageCount;
    this.cursor = cursor;
  }
}

/**
 * Collects items across paginated Slack API responses, detecting cursor cycles
 * to prevent infinite pagination while allowing legitimate advancing pagination
 * of any size to complete.
 *
 * Cycle detection: each non-null cursor returned by a page is recorded; if the
 * same cursor is seen again, {@link SlackCursorCycleError} is thrown. A safety
 * limit of {@link SLACK_CURSOR_PAGES_MAX} pages acts as a last-resort backstop.
 */
export async function collectSlackCursorPages<
  TItem,
  TResponse extends SlackCursorResponse,
>(params: {
  fetchPage: (cursor?: string) => Promise<TResponse>;
  collectPageItems: (response: TResponse) => TItem[];
}): Promise<TItem[]> {
  const items: TItem[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  for (let page = 0; page < SLACK_CURSOR_PAGES_MAX; page += 1) {
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new SlackCursorCycleError(page, cursor);
      }
      seenCursors.add(cursor);
    }

    const response = await params.fetchPage(cursor);
    items.push(...params.collectPageItems(response));
    cursor = response.response_metadata?.next_cursor?.trim() || undefined;
    if (!cursor) {
      return items;
    }
  }
  // Safety backstop — cursor never went null within the page budget.
  throw new SlackCursorCycleError(SLACK_CURSOR_PAGES_MAX, cursor!);
}
