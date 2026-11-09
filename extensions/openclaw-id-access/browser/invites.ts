// Invite creation (spec section 6.3): a fresh link secret, its proof key, and an
// InviteCap signed by this owner device. Only the cap and the proof key reach
// the Gateway; the secret stays in the link fragment the owner shares.
import {
  buildInviteLink,
  bytesToBase64url,
  deriveInviteProofKey,
  fingerprint,
  generateInviteSecret,
  inviteSecretHash,
  PENDING_REDEMPTION_TTL_SECONDS,
  type IrohEndpointKey,
  type MemberRole,
  type PublicKeyText,
} from "@openclaw/openclaw-id-protocol";
import { signAsOwner, signMembershipChange } from "./owner-signing.js";
import type { Invite, Link, RemovalSummary } from "./types.js";

type Request = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

/** A created invite link, shown once with its expiry. */
export type CreatedInvite = { email: string; url: string; expiresAt: number };

/** Registers an invite for `email` and returns the link to share. */
export async function createInvite(
  request: Request,
  link: Link,
  email: string,
  role: MemberRole,
): Promise<CreatedInvite> {
  const now = Math.floor(Date.now() / 1000);
  const { invite_id, secret } = generateInviteSecret();
  const proofKey = await deriveInviteProofKey(secret);
  const cap = await signAsOwner(link, "InviteCap", {
    claw_id: link.clawId ?? "",
    invite_id,
    role,
    audience: { kind: "email", value: email },
    label: email,
    created_at: now,
    expires_at: now + PENDING_REDEMPTION_TTL_SECONDS,
    single_use: true,
    secret_hash: await inviteSecretHash(proofKey),
  });
  await request("openclawId.authority", {
    action: "register_invite",
    cap,
    proofKey: bytesToBase64url(proofKey),
  });
  // SAFETY: the Gateway reports rootPub as a formatted ed25519 key; fingerprint rejects anything else.
  const rootFp = await fingerprint(link.rootPub as PublicKeyText);
  return {
    email,
    url: buildInviteLink(link.hostname ?? "", { invite_id, secret, root_fp: rootFp }),
    expiresAt: now + PENDING_REDEMPTION_TTL_SECONDS,
  };
}

/** Approves (adds the member) or denies a pending redemption with a signed MembershipChange. */
export async function decideInvite(
  request: Request,
  link: Link,
  invite: Invite,
  approve: boolean,
): Promise<void> {
  const pending = invite.pending;
  if (!pending) {
    return;
  }
  const statement = await signMembershipChange(
    link,
    approve
      ? {
          op: "add",
          account_id: pending.accountId,
          role: invite.role,
          // SAFETY: the Gateway admits a pending redemption only with a formatted iroh key, and re-verifies the change.
          peer_keys: [pending.peerKey as IrohEndpointKey],
          invite_id: invite.inviteId,
        }
      : { op: "deny_invite", invite_id: invite.inviteId },
  );
  await request("openclawId.authority", { action: "submit", statement });
}

/**
 * Removes a member: the Gateway cuts their tunnel access, sessions, tokens and
 * runs, and reports what it cut (null when the Gateway reports nothing).
 */
export async function removeMember(
  request: Request,
  link: Link,
  accountId: string,
): Promise<RemovalSummary | null> {
  const statement = await signMembershipChange(link, { op: "remove", account_id: accountId });
  const result = await request<{ removal?: RemovalSummary | null }>("openclawId.authority", {
    action: "submit",
    statement,
  });
  return result?.removal ?? null;
}
