import { normalizeBoundedOptionalString as readBoundedId } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject, type CodexThreadListParams } from "./protocol.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";

const DESCENDANT_PAGE_LIMIT = 100;
const MAX_DESCENDANT_PAGES = 100;
const MAX_THREAD_ID_LENGTH = 256;
const MAX_CURSOR_LENGTH = 4096;

function readNextCursor(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.length > MAX_CURSOR_LENGTH) {
    throw new Error("Codex app-server returned an invalid descendant-list cursor");
  }
  return value;
}

/**
 * Native archive includes the spawned subtree. Enumerate that same subtree first so an
 * OpenClaw-owned descendant cannot be stopped as an undocumented side effect.
 */
export async function assertCodexArchiveDescendantsUnowned(params: {
  bindingStore: CodexAppServerBindingStore;
  threadId: string;
  listPage: (request: CodexThreadListParams) => Promise<unknown>;
  assertDescendantIdle: (threadId: string) => Promise<void>;
}): Promise<void> {
  const ancestorThreadId = readBoundedId(params.threadId, MAX_THREAD_ID_LENGTH);
  if (!ancestorThreadId) {
    throw new Error("cannot verify Codex archive descendants for an invalid thread id");
  }

  const seenThreadIds = new Set<string>([ancestorThreadId]);
  let pageIndex = 0;
  // Native archive also stops archived descendants resumed through collaboration.
  for (const archived of [false, true]) {
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (pageIndex++ >= MAX_DESCENDANT_PAGES) {
        throw new Error("Codex descendant enumeration exceeded its safety limit");
      }
      const response = await params.listPage({
        ancestorThreadId,
        archived,
        limit: DESCENDANT_PAGE_LIMIT,
        sortKey: "created_at",
        sortDirection: "desc",
        useStateDbOnly: true,
        ...(cursor ? { cursor } : {}),
      });
      if (!isJsonObject(response) || !Array.isArray(response.data)) {
        throw new Error("Codex app-server returned an invalid descendant-list response");
      }
      if (response.data.length > DESCENDANT_PAGE_LIMIT) {
        throw new Error("Codex app-server exceeded the descendant-list page limit");
      }

      for (const value of response.data) {
        if (!isJsonObject(value)) {
          throw new Error("Codex app-server returned an invalid descendant thread");
        }
        const descendantThreadId = readBoundedId(value.id, MAX_THREAD_ID_LENGTH);
        if (!descendantThreadId) {
          throw new Error("Codex app-server returned a descendant without a valid thread id");
        }
        if (seenThreadIds.has(descendantThreadId)) {
          throw new Error("Codex app-server returned a cyclic descendant thread list");
        }
        seenThreadIds.add(descendantThreadId);
        await params.assertDescendantIdle(descendantThreadId);
        if (await params.bindingStore.hasOtherThreadOwner(descendantThreadId)) {
          throw new Error(
            "cannot archive a Codex thread while a spawned descendant is owned by an OpenClaw session",
          );
        }
      }

      cursor = readNextCursor(response.nextCursor);
      if (cursor) {
        if (seenCursors.has(cursor)) {
          throw new Error("Codex app-server returned a repeated descendant-list cursor");
        }
        seenCursors.add(cursor);
      }
    } while (cursor);
  }
}
