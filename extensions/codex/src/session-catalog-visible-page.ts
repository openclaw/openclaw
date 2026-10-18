import { startCodexCatalogListTiming } from "./session-catalog-diagnostics.js";
import { CodexCatalogListRequest } from "./session-catalog-list-request.js";
import {
  filterCatalogPageByTitle,
  MAX_TITLE_SEARCH_CATALOG_PAGES,
  parseCatalogPage,
} from "./session-catalog-parsing.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogPage,
} from "./session-catalog-types.js";

type VisiblePageParams = {
  control: CodexSessionCatalogControl;
  cursor?: string;
  cwd?: string;
  excludedThreadIds?: ReadonlySet<string>;
  limit: number;
  onExcludedThread?: (thread: { threadId: string; rolloutPath?: string }) => Promise<void>;
  searchTerm?: string;
  signal?: AbortSignal;
};

/** Fill exclusions from bounded resident pages. */
export class CodexCatalogVisiblePage {
  private readonly sessions: CodexSessionCatalogPage["sessions"] = [];
  private cursor: string | undefined;
  private backwardsCursor: string | undefined;
  private readonly seenCursors = new Set<string>();
  private pages = 0;
  private complete = false;
  private readonly request = new CodexCatalogListRequest();

  constructor(private readonly params: VisiblePageParams) {
    this.cursor = params.cursor;
  }

  async next(): Promise<{ done: false } | { done: true; page: CodexSessionCatalogPage }> {
    try {
      const step = await this.request.run(() => this.nextPage());
      if (step.done) {
        this.request.resolved();
      }
      return step;
    } catch (error) {
      if (this.params.signal?.aborted) {
        this.request.close();
      } else {
        this.request.rejected(error);
      }
      throw error;
    }
  }

  close(): void {
    this.complete = true;
    this.request.close();
  }

  private async nextPage(): Promise<
    { done: false } | { done: true; page: CodexSessionCatalogPage }
  > {
    if (this.complete) {
      throw new Error("Codex catalog page is already complete");
    }
    const params = this.params;
    params.signal?.throwIfAborted();
    const finishTiming = startCodexCatalogListTiming("controlWaitSumMs", "controlPageCalls");
    let rawPage: CodexSessionCatalogPage;
    try {
      rawPage = await params.control.listPage({
        limit: params.limit - this.sessions.length,
        ...(this.cursor ? { cursor: this.cursor } : {}),
        ...(params.searchTerm ? { searchTerm: params.searchTerm } : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
      });
    } finally {
      finishTiming();
    }
    this.request.assertActive();
    params.signal?.throwIfAborted();
    const page = filterCatalogPageByTitle(parseCatalogPage(rawPage), params.searchTerm);
    if (this.pages++ === 0) {
      this.backwardsCursor = page.backwardsCursor;
    }
    let excludedFromPage = false;
    for (const managed of rawPage.managedThreads ?? []) {
      excludedFromPage = true;
      params.signal?.throwIfAborted();
      await params.onExcludedThread?.(managed);
    }
    for (const session of page.sessions) {
      if (!params.excludedThreadIds?.has(session.threadId)) {
        this.sessions.push(session);
        continue;
      }
      excludedFromPage = true;
      params.signal?.throwIfAborted();
      await params.onExcludedThread?.({ threadId: session.threadId });
    }
    const nextCursor = page.nextCursor;
    if (!nextCursor || this.sessions.length >= params.limit || !excludedFromPage) {
      this.complete = true;
    } else {
      if (this.seenCursors.has(nextCursor)) {
        throw new Error("Codex session catalog returned a repeated exclusion cursor");
      }
      this.seenCursors.add(nextCursor);
      this.cursor = nextCursor;
      this.complete = this.pages >= MAX_TITLE_SEARCH_CATALOG_PAGES || !this.request.hasPages;
    }
    return this.complete
      ? {
          done: true,
          page: {
            sessions: this.sessions.slice(0, params.limit),
            ...(nextCursor ? { nextCursor } : {}),
            ...(this.backwardsCursor ? { backwardsCursor: this.backwardsCursor } : {}),
          },
        }
      : { done: false };
  }
}

/** Node and direct callers finish the same bounded outer algorithm inline. */
export async function listVisiblePage(params: VisiblePageParams): Promise<CodexSessionCatalogPage> {
  const operation = new CodexCatalogVisiblePage(params);
  try {
    for (;;) {
      const step = await operation.next();
      if (step.done) {
        return step.page;
      }
    }
  } finally {
    operation.close();
  }
}
