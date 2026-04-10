import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type AcpSessionInteractionMode = "interactive" | "parent-owned-background";

type SessionInteractionEntry = Pick<SessionEntry, "spawnedBy" | "parentSessionKey" | "acp">;

export function resolveAcpSessionInteractionMode(
  entry?: SessionInteractionEntry | null,
): AcpSessionInteractionMode {
  // Parent-owned oneshot ACP sessions are background work delegated from another session.
  // They should report back through the parent task notifier instead of speaking directly
  // on the user-facing channel themselves.
  if (entry?.acp?.mode !== "oneshot") {
    return "interactive";
  }
  if (normalizeOptionalString(entry.spawnedBy) || normalizeOptionalString(entry.parentSessionKey)) {
    return "parent-owned-background";
  }
  return "interactive";
}

export function isParentOwnedBackgroundAcpSession(entry?: SessionInteractionEntry | null): boolean {
  return resolveAcpSessionInteractionMode(entry) === "parent-owned-background";
}
