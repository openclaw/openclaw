// How long the reference membership authority keeps an invite record. A record matters only
// while its cap is valid (a consumed record stops the same cap from being registered again)
// or while a redemption waits for an owner. Once the cap has expired, registration and
// redemption refuse it anyway, so the record can be deleted without keeping any history.
import type { UnixSeconds } from "../statements/types.js";
import { CERT_CLOCK_SKEW_SECONDS, type AuthorityState, type InviteRecord } from "./state.js";

/**
 * True when an invite record can be deleted at `now`: its cap expired more than the clock skew
 * ago and no redemption is pending on it (pending ones wait for an owner or for their own expiry).
 */
export function isInviteSpent(invite: InviteRecord, now: UnixSeconds): boolean {
  return invite.status !== "pending" && invite.cap.expires_at + CERT_CLOCK_SKEW_SECONDS <= now;
}

/** Deletes every spent invite record; returns the new state and the deleted invite ids. */
export function withoutSpentInvites(
  state: AuthorityState,
  now: UnixSeconds,
): { state: AuthorityState; removed: string[] } {
  const removed = Object.entries(state.invites)
    .filter(([, invite]) => isInviteSpent(invite, now))
    .map(([inviteId]) => inviteId);
  if (removed.length === 0) {
    return { state, removed };
  }
  const gone = new Set(removed);
  const invites = Object.fromEntries(
    Object.entries(state.invites).filter(([inviteId]) => !gone.has(inviteId)),
  );
  return { state: { ...state, invites }, removed };
}
