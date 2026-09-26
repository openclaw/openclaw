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

/**
 * Only the owning parent skips the A2A flow; unrelated sessions with broad
 * visibility still use the normal path when sending to the same target.
 */
export function isRequesterParentOfBackgroundAcpSession(
  entry: SessionInteractionEntry | null | undefined,
  requesterSessionKey: string | null | undefined,
): boolean {
  if (!isParentOwnedBackgroundAcpSession(entry)) {
    return false;
  }
  const requester = normalizeOptionalString(requesterSessionKey);
  if (!requester) {
    return false;
  }
  const spawnedBy = normalizeOptionalString(entry?.spawnedBy);
  const parentSessionKey = normalizeOptionalString(entry?.parentSessionKey);
  return requester === spawnedBy || requester === parentSessionKey;
}
