import type { CodexManagedThreadStore } from "./app-server/managed-thread-store.js";
import type {
  CodexThread,
  CodexThreadListParams,
  CodexThreadListResponse,
} from "./app-server/protocol.js";
import { withTimeout } from "./app-server/timeout.js";
import type { CodexCatalogIndex } from "./session-catalog-index.js";
import {
  CatalogParamsError,
  isInteractiveThreadSource,
  readControlCursor,
} from "./session-catalog-parsing.js";
import { readCodexSessionMeta } from "./session-catalog-provenance.js";

/** Exact identity and native membership are independent of resident retention. */
export async function requireEligibleCodexThread(params: {
  threadId: string;
  requests: {
    requestTimeoutMs: number;
    index(): Promise<CodexCatalogIndex>;
    readThread(threadId: string, includeTurns: boolean, timeoutMs?: number): Promise<CodexThread>;
    listThreads(params: CodexThreadListParams, timeoutMs: number): Promise<CodexThreadListResponse>;
  };
  localSessionsRoot?: string;
  sourceHomeId?: string;
  managedThreads?: CodexManagedThreadStore;
  now: () => number;
}): Promise<CodexThread> {
  const { requests, threadId } = params;
  const deadline = params.now() + requests.requestTimeoutMs;
  const unverified = () =>
    new CatalogParamsError(
      "Codex session eligibility could not be verified. Refresh the catalog and verify the session in its native Codex home before retrying.",
    );
  const remaining = () => {
    const timeoutMs = Math.ceil(deadline - params.now());
    if (timeoutMs <= 0) {
      throw unverified();
    }
    return timeoutMs;
  };
  const verify = async () => {
    if (params.sourceHomeId && (await params.managedThreads?.has(params.sourceHomeId, threadId))) {
      throw unverified();
    }
    remaining();
    const index = await requests.index();
    const root = params.localSessionsRoot;
    if (root && index.get(threadId)?.archived) {
      throw unverified();
    }
    const thread = await requests.readThread(threadId, false, remaining());
    remaining();
    if (
      thread.id !== threadId ||
      thread.ephemeral === true ||
      !isInteractiveThreadSource(thread.source)
    ) {
      throw unverified();
    }
    if (!root) {
      // Remote thread/read includes archived threads, so every action needs
      // fresh non-archived membership on the captured home.
      const { CODEX_CATALOG_NATIVE_PAGE_LIMIT } =
        await import("./session-catalog-native-projection.js");
      const { CODEX_CATALOG_MAX_ROWS } = await import("./session-catalog-limits.js");
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (;;) {
        const page = await requests.listThreads(
          {
            archived: false,
            limit: CODEX_CATALOG_NATIVE_PAGE_LIMIT,
            modelProviders: [],
            sortKey: "recency_at",
            sortDirection: "desc",
            ...(thread.cwd ? { cwd: thread.cwd } : {}),
            ...(cursor ? { cursor } : {}),
          },
          remaining(),
        );
        remaining();
        const listed = page.data.find((entry) => entry.id === threadId);
        if (listed) {
          if (listed.ephemeral === true || !isInteractiveThreadSource(listed.source)) {
            throw unverified();
          }
          break;
        }
        const nextCursor = readControlCursor(page.nextCursor, "next response");
        if (!nextCursor || seenCursors.has(nextCursor)) {
          throw unverified();
        }
        seenCursors.add(nextCursor);
        if (seenCursors.size > CODEX_CATALOG_MAX_ROWS) {
          const oldest = seenCursors.values().next().value;
          if (oldest !== undefined) {
            seenCursors.delete(oldest);
          }
        }
        cursor = nextCursor;
      }
    }
    if (root) {
      // Native reads resolve the selected rollout; a cached path can predate a revert.
      if (!thread.path) {
        throw unverified();
      }
      const metadata = await readCodexSessionMeta(root, thread.path, threadId);
      remaining();
      if (
        !metadata ||
        !isInteractiveThreadSource(metadata.source) ||
        metadata.originator === "openclaw"
      ) {
        throw unverified();
      }
      await index.upsertThread(thread);
      remaining();
    }
    return thread;
  };
  return await withTimeout(
    verify(),
    requests.requestTimeoutMs,
    "Codex session eligibility could not be verified",
    unverified,
  );
}
