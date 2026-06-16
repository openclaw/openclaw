// Reconstructs thread history from a server-fetched Mattermost thread so a bot
// re-mentioned inside an existing thread after a restart / session-clear (when
// the in-memory history window is empty) replies with context instead of blind.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MattermostPost, MattermostThread } from "./client.js";
import type { HistoryEntry } from "./runtime-api.js";

/**
 * Decides whether an empty in-memory history window for a threaded mention is a
 * genuine restart / session-clear recovery (backfill from the server) versus
 * the ordinary empty window left behind after a successful turn (do NOT
 * backfill — the shared turn kernel clears the pending-history window after
 * every successful dispatch, so an empty window is normal for active threads).
 *
 * The discriminator is process lifetime: a thread root that this process has
 * already serviced has, by definition, had its window populated and then
 * cleared by the kernel, so a later empty window is steady-state, not recovery.
 * Only the FIRST empty-window sighting of a root (i.e. its window was never
 * built in this process) is treated as recovery. `seenThreadRoots` is the
 * caller-owned set of roots already serviced this process; this function reads
 * and updates it so the recovery path fires at most once per root per lifetime.
 *
 * Pure (no network) and side-effect-scoped to the passed-in set, so it stays
 * unit-testable under the mocked SDK shim.
 */
export function shouldBackfillThreadFromServer(params: {
  threadRootId?: string;
  historyLimit: number;
  currentWindowSize: number;
  seenThreadRoots: Set<string>;
}): boolean {
  const { threadRootId, historyLimit, currentWindowSize, seenThreadRoots } = params;
  if (!threadRootId || historyLimit <= 0) {
    return false;
  }
  // Once a root has been serviced this process, its empty window is the normal
  // post-turn cleared state — never recovery. Mark every serviced root so the
  // recovery path cannot re-fire after the kernel clears the window.
  const alreadyServiced = seenThreadRoots.has(threadRootId);
  seenThreadRoots.add(threadRootId);
  if (alreadyServiced) {
    return false;
  }
  // First sighting this process: backfill only when there is genuinely no
  // in-memory context to replay (gateway restart / session clear).
  return currentWindowSize === 0;
}

/**
 * Maps a fetched thread (`GET /posts/{rootId}/thread`) into ordered history
 * entries, skipping the current post and any non-message/system posts, then
 * trims to the last `limit` entries.
 *
 * Pure (no network): callers resolve sender display names up front and pass a
 * lookup so this stays unit-testable under the mocked Telegram-style SDK shim.
 */
export function buildThreadBackfillEntries(params: {
  thread: MattermostThread;
  currentPostId?: string;
  limit: number;
  resolveSenderLabel: (userId: string) => string | undefined;
  isSystemPost?: (post: MattermostPost) => boolean;
}): HistoryEntry[] {
  const { thread, currentPostId, limit, resolveSenderLabel } = params;
  if (limit <= 0) {
    return [];
  }
  const order = Array.isArray(thread.order) ? thread.order : [];
  const posts = thread.posts ?? {};
  const entries: HistoryEntry[] = [];
  for (const postId of order) {
    const post = posts[postId];
    if (!post) {
      continue;
    }
    if (currentPostId && post.id === currentPostId) {
      continue;
    }
    if (params.isSystemPost?.(post)) {
      continue;
    }
    const body = normalizeOptionalString(post.message);
    const hasFiles = Array.isArray(post.file_ids) && post.file_ids.length > 0;
    if (!body && !hasFiles) {
      continue;
    }
    const userId = normalizeOptionalString(post.user_id);
    const sender = (userId ? resolveSenderLabel(userId) : undefined) ?? userId ?? "unknown";
    entries.push({
      sender,
      body:
        body ?? `[Mattermost ${post.file_ids && post.file_ids.length === 1 ? "file" : "files"}]`,
      timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
      messageId: normalizeOptionalString(post.id),
    });
  }
  return entries.slice(-limit);
}
