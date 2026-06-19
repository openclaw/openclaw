// Discord plugin module implements thread session close behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  listSessionEntries,
  resolveStorePath,
  updateSessionStore,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Marks every session entry in the store whose key contains {@link threadId}
 * as closed by removing the store row.
 *
 * Removing the row forces the next inbound message in that archived Discord
 * thread to start a fresh conversation without deleting on-disk transcript
 * history. Timestamp-only invalidation is not enough for idle/no-expiry
 * thread sessions because such entries can still evaluate fresh.
 */
export async function closeDiscordThreadSessions(params: {
  cfg: OpenClawConfig;
  accountId: string;
  threadId: string;
}): Promise<number> {
  const { cfg, accountId, threadId } = params;

  const normalizedThreadId = normalizeOptionalLowercaseString(threadId) ?? "";
  if (!normalizedThreadId) {
    return 0;
  }

  // Match when the threadId appears as a complete colon-separated segment.
  // e.g. "999" must be followed by ":" (middle) or end-of-string (final).
  // Using a regex avoids false-positives where one snowflake is a prefix of
  // another (e.g. searching for "999" must not match ":99900").
  //
  // Session key shapes:
  //   agent:<agentId>:discord:channel:<threadId>
  //   agent:<agentId>:discord:channel:<parentId>:thread:<threadId>
  const segmentRe = new RegExp(`:${normalizedThreadId}(?::|$)`, "i");

  function sessionKeyContainsThreadId(key: string): boolean {
    return segmentRe.test(key);
  }

  // Resolve the store file. We pass `accountId` as `agentId` here to mirror
  // how other Discord subsystems resolve their per-account sessions stores.
  const storePath = resolveStorePath(cfg.session?.store, { agentId: accountId });

  let resetCount = 0;

  for (const { sessionKey, entry } of listSessionEntries({ storePath })) {
    if (!sessionKeyContainsThreadId(sessionKey)) {
      continue;
    }
    const removed = await updateSessionStore(
      storePath,
      (store) => {
        const current = store[sessionKey];
        if (!current) {
          return false;
        }
        if (current.updatedAt !== entry.updatedAt || current.sessionId !== entry.sessionId) {
          return false;
        }
        delete store[sessionKey];
        return true;
      },
      {
        skipSaveWhenResult: (result) => result !== true,
      },
    );
    if (removed) {
      resetCount += 1;
    }
  }

  return resetCount;
}
