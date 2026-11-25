// How long the reference membership authority keeps an invite record. A record matters only
// while its cap is valid (a consumed record stops the same cap from being registered again)
// or while a redemption waits for an owner. Once the cap has expired, registration and
// redemption refuse it anyway, so the record can be deleted without keeping any history.
import { MAX_INVITE_LIFETIME_SECONDS } from "../invites.js";
import type { UnixSeconds } from "../statements/types.js";
import {
  CERT_CLOCK_SKEW_SECONDS,
  type AuthorityState,
  type InviteRecord,
  type NodeInviteRecord,
} from "./state.js";

/**
 * True when an invite record can be deleted at `now`: its cap expired more than the clock skew
 * ago and no redemption is pending on it (pending ones wait for an owner or for their own expiry).
 */
export function isInviteSpent(invite: InviteRecord | NodeInviteRecord, now: UnixSeconds): boolean {
  return invite.status !== "pending" && invite.cap.expires_at + CERT_CLOCK_SKEW_SECONDS <= now;
}

/** Deletes every spent invite record; returns the new state and the deleted invite ids. */
export function withoutSpentInvites(
  state: AuthorityState,
  now: UnixSeconds,
): { state: AuthorityState; removed: string[] } {
  const removed = [...Object.entries(state.invites), ...Object.entries(state.node_invites)]
    .filter(([, invite]) => isInviteSpent(invite, now))
    .map(([inviteId]) => inviteId);
  if (removed.length === 0) {
    return { state, removed };
  }
  const gone = new Set(removed);
  const invites = Object.fromEntries(
    Object.entries(state.invites).filter(([inviteId]) => !gone.has(inviteId)),
  );
  const node_invites = Object.fromEntries(
    Object.entries(state.node_invites).filter(([id]) => !gone.has(id)),
  );
  return { state: { ...state, invites, node_invites }, removed };
}

// Why an invite expiring at `expiresAt` cannot be registered at `now`, or null: it has already
// expired, or it lasts longer than MAX_INVITE_LIFETIME_SECONDS (beyond the clock skew).
export function inviteLifetimeError(
  expiresAt: UnixSeconds,
  now: UnixSeconds,
): { code: "expired" | "limit_reached"; detail: string } | null {
  if (expiresAt <= now) {
    return { code: "expired", detail: "invite expired" };
  }
  if (expiresAt > now + MAX_INVITE_LIFETIME_SECONDS + CERT_CLOCK_SKEW_SECONDS) {
    const days = MAX_INVITE_LIFETIME_SECONDS / 86400;
    return { code: "limit_reached", detail: `an invite lasts at most ${days} days` };
  }
  return null;
}
