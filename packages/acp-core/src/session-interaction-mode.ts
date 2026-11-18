import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

type SessionInteractionEntry = {
  spawnedBy?: string;
  parentSessionKey?: string;
  acp?: unknown;
};

/** Returns true for ACP sessions delegated from a parent session instead of user-facing chat. */
export function isParentOwnedBackgroundAcpSession(entry?: SessionInteractionEntry | null): boolean {
  return Boolean(
    entry?.acp &&
    (normalizeOptionalString(entry.spawnedBy) || normalizeOptionalString(entry.parentSessionKey)),
  );
}
