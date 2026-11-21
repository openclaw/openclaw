import type { readSessionEntrySummariesInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../../sessions/session-id-resolution.js";

export function resolveLegacyCompactionSessionKey(
  entries: Awaited<ReturnType<typeof readSessionEntrySummariesInWorker>>,
  successorSessionId: string,
  current: { sessionId: string; sessionKey?: string },
  retainedLookupKey: string | undefined,
): string | undefined {
  const retainedEntry = entries.find(({ sessionKey }) => sessionKey === retainedLookupKey)?.entry;
  const matches = entries.filter(({ entry }) => entry.sessionId === successorSessionId);
  const preferred = resolvePreferredSessionKeyForSessionIdMatches(
    matches.map(({ sessionKey, entry }) => [sessionKey, entry]),
    successorSessionId,
  );
  const mappedToRetainedKey = matches.some(({ sessionKey }) => sessionKey === current.sessionKey);
  return retainedEntry?.sessionId === successorSessionId ||
    (retainedEntry?.sessionId === current.sessionId &&
      (matches.length === 0 || mappedToRetainedKey))
    ? current.sessionKey
    : (preferred ?? (matches.length === 0 && !retainedEntry ? current.sessionKey : undefined));
}
