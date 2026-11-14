import {
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  isCodexAppServerLiveThreadProtected,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";

/**
 * Retention keeps a native parent's subscription alive and blocks only the
 * release a new turn performs when it has nothing to continue. An idle
 * subscription, or a claim a turn keeps, still carries the announce.
 */
export function canAnnounceToRetainedParent(
  client: CodexAppServerClient,
  threadId: string,
): boolean {
  return (
    !isCodexAppServerLiveThreadProtected(client, threadId) ||
    (hasCodexAppServerLiveThread(client, threadId) &&
      !isCodexAppServerLiveThreadClaimed(client, threadId))
  );
}
