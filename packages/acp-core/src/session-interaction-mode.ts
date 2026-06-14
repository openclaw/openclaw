// ACP Core module implements session interaction mode behavior.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { HubDelegatedSessionMeta } from "./hub-delegated.js";

type AcpSessionInteractionMode = "interactive" | "parent-owned-background";

type SessionInteractionEntry = {
  spawnedBy?: string;
  parentSessionKey?: string;
  hubDelegated?: HubDelegatedSessionMeta | null;
  acp?: unknown;
};

/** Hub-delegated and parent-owned ACP child sessions must stay off user-visible chat surfaces. */
export function requiresInternalAcpSessionEffects(entry?: SessionInteractionEntry | null): boolean {
  const hubDelegatedOwner = normalizeOptionalString(entry?.hubDelegated?.ownerSessionKey);
  const hubDelegated = Boolean(hubDelegatedOwner);
  return hubDelegated || isParentOwnedBackgroundAcpSession(entry);
}

function resolveAcpSessionInteractionMode(
  entry?: SessionInteractionEntry | null,
): AcpSessionInteractionMode {
  // Hub-delegated workers are parent-owned even when sqlite ACP metadata is missing.
  if (normalizeOptionalString(entry?.hubDelegated?.ownerSessionKey)) {
    return "parent-owned-background";
  }
  // Parent-owned ACP sessions are background work delegated from another session.
  // They should report back through the parent task notifier instead of speaking directly
  // on the user-facing channel themselves.
  if (!entry?.acp) {
    return "interactive";
  }
  if (normalizeOptionalString(entry.spawnedBy) || normalizeOptionalString(entry.parentSessionKey)) {
    return "parent-owned-background";
  }
  return "interactive";
}

/** Returns true for ACP sessions delegated from a parent session instead of user-facing chat. */
export function isParentOwnedBackgroundAcpSession(entry?: SessionInteractionEntry | null): boolean {
  return resolveAcpSessionInteractionMode(entry) === "parent-owned-background";
}

/**
 * Returns true when `entry` is a parent-owned background ACP session AND the
 * given `requesterSessionKey` is the session that spawned/owns it. This is a
 * strictly narrower check than {@link isParentOwnedBackgroundAcpSession}: the
 * target must match *and* the caller must be the parent.
 *
 * Used to gate behaviors that only make sense for the parent↔own-child pair
 * (e.g. skipping the A2A ping-pong flow in `sessions_send`), so that an
 * unrelated session with broad visibility (e.g. `tools.sessions.visibility=all`)
 * sending to the same target is still routed through the normal A2A path.
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
  const ownerSessionKey = normalizeOptionalString(entry?.hubDelegated?.ownerSessionKey);
  if (ownerSessionKey) {
    return requester === ownerSessionKey;
  }
  const spawnedBy = normalizeOptionalString(entry?.spawnedBy);
  const parentSessionKey = normalizeOptionalString(entry?.parentSessionKey);
  return requester === spawnedBy || requester === parentSessionKey;
}
