// Discord plugin module implements thread session close behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  listSessionEntries,
  patchSessionEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Marks every session entry in the store whose key contains {@link threadId}
 * as closed so the next inbound message rolls over to a fresh session.
 *
 * The close marker makes idle/no-expiry thread sessions stale without deleting
 * the entry. Keeping the entry lets the normal rollover lifecycle archive and
 * link the old transcript when the archived thread receives another message.
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
  const closedAt = Date.now();

  for (const { sessionKey, entry } of listSessionEntries({ storePath })) {
    if (!sessionKeyContainsThreadId(sessionKey) || entry.sessionClosedAt != null) {
      continue;
    }
    let markedClosed = false;
    await patchSessionEntry({
      storePath,
      sessionKey,
      replaceEntry: true,
      update: (current) => {
        if (current.updatedAt !== entry.updatedAt || current.sessionId !== entry.sessionId) {
          return null;
        }
        const next = {
          ...current,
          lastInteractionAt: undefined,
          sessionClosedAt: closedAt,
          updatedAt: 0,
        };
        markedClosed = true;
        return next;
      },
    });
    if (markedClosed) {
      resetCount += 1;
    }
  }

  return resetCount;
}
