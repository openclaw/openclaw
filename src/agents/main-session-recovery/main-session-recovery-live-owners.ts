import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "../embedded-agent-runner/active-run-projections.js";

function normalizeStringSet(values: Iterable<string> | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return normalized;
}

export function createCurrentProcessOwnerLookup(params: {
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
}): (entry: SessionEntry, sessionKey: string) => boolean {
  const providedIds =
    params.activeSessionIds === undefined ? undefined : normalizeStringSet(params.activeSessionIds);
  const providedKeys =
    params.activeSessionKeys === undefined
      ? undefined
      : normalizeStringSet(params.activeSessionKeys);
  // Re-read live projections at each check so an async scan cannot retain a stale owner view.
  return (entry, sessionKey) => {
    const ids = providedIds ?? normalizeStringSet(listActiveEmbeddedRunSessionIds());
    const keys = providedKeys ?? normalizeStringSet(listActiveEmbeddedRunSessionKeys());
    return ids.has(entry.sessionId) || (ids.size === 0 && keys.has(sessionKey));
  };
}
