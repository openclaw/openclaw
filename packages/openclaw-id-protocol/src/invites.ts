// Invite links, the invite proof key and redemption proofs (owner-key spec section 6.3).
import {
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  concatBytes,
  equalBytes,
  hexToBytes,
  utf8,
  type Bytes,
} from "./bytes.js";
import { hkdfSha256, hmacSha256, randomBytes, sha256 } from "./crypto.js";
import { canonicalize } from "./jcs.js";
import {
  isKeyFingerprint,
  isRandomId,
  type Ed25519PublicKey,
  type IrohEndpointKey,
  type KeyFingerprint,
} from "./keys.js";
import type { InviteCapBody, SignedStatement, UnixSeconds } from "./statements/types.js";
import {
  failure,
  verifyInviteRedemptionSignature,
  type VerifyResult,
} from "./statements/verify.js";

/** Link secret length (bytes). The secret travels only in the URL fragment. */
export const INVITE_SECRET_BYTES = 32;
/** A pending redemption expires after this long without an owner decision (spec open question 6). */
export const PENDING_REDEMPTION_TTL_SECONDS = 7 * 86400;

const PROOF_DOMAIN = "openclaw/invite-proof/v1\0";

/** What the invite link fragment carries. */
export type InviteLink = { invite_id: string; secret: Bytes; root_fp: KeyFingerprint };

/** Generates an invite id and link secret. */
export function generateInviteSecret(): { invite_id: string; secret: Bytes } {
  return { invite_id: bytesToHex(randomBytes(16)), secret: randomBytes(INVITE_SECRET_BYTES) };
}

/**
 * The proof key the Gateway stores for an invite: HKDF(secret, "openclaw/invite/v1", "proof-key").
 * The owner device registers it directly at the Gateway with the InviteCap; the cap's
 * `secret_hash` is SHA-256 of it. Discovery sees neither.
 */
export async function deriveInviteProofKey(secret: Uint8Array): Promise<Bytes> {
  return hkdfSha256(secret, "openclaw/invite/v1", "proof-key", 32);
}

/** `secret_hash` for an InviteCap: hex SHA-256 of the proof key. */
export async function inviteSecretHash(proofKey: Uint8Array): Promise<string> {
  return bytesToHex(await sha256(proofKey));
}

/** Builds `https://<host>/join#i=<invite_id>.<secret>&r=<fp hex>`. The fragment never reaches a server. */
export function buildInviteLink(host: string, link: InviteLink): string {
  return `https://${host}/join#i=${link.invite_id}.${bytesToBase64url(link.secret)}&r=${link.root_fp.slice(3)}`;
}

/** Parses the fragment of an invite link (with or without the leading `#`). */
export function parseInviteFragment(fragment: string): InviteLink | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const [inviteId, secretText] = (params.get("i") ?? "").split(".");
  const rootFp = `fp:${params.get("r") ?? ""}`;
  if (!isRandomId(inviteId) || !secretText || !isKeyFingerprint(rootFp)) {
    return null;
  }
  try {
    const secret = base64urlToBytes(secretText);
    return secret.length === INVITE_SECRET_BYTES
      ? { invite_id: inviteId, secret, root_fp: rootFp }
      : null;
  } catch {
    return null;
  }
}

/** Fields covered by a redemption proof. */
export type RedemptionProofParts = {
  claw_id: string;
  invite_id: string;
  account_id: string;
  device_pub: Ed25519PublicKey;
  peer_key: IrohEndpointKey;
};

/** proof = hex HMAC-SHA-256(proof key, "openclaw/invite-proof/v1\0" || JCS(parts)). */
export async function computeRedemptionProof(
  proofKey: Uint8Array,
  parts: RedemptionProofParts,
): Promise<string> {
  return bytesToHex(
    await hmacSha256(proofKey, concatBytes(utf8(PROOF_DOMAIN), utf8(canonicalize(parts)))),
  );
}

/** The identity OpenClaw ID asserts for the redeeming account (audience check only). */
export type AssertedIdentity = { account_id: string; email: string | null };

/**
 * Gateway-side check of an InviteRedemption: self-signature by D_I, the invite matches,
 * it is unexpired, the HMAC proof is right under the stored proof key, and the asserted
 * identity matches the audience. Success means "record as pending", never "admit".
 */
export async function verifyInviteRedemption(
  redemption: SignedStatement<"InviteRedemption">,
  invite: InviteCapBody,
  proofKey: Uint8Array,
  identity: AssertedIdentity,
  now: UnixSeconds,
): Promise<VerifyResult<"InviteRedemption">> {
  const signed = await verifyInviteRedemptionSignature(redemption);
  if (!signed.ok) {
    return signed;
  }
  const body = redemption.body;
  if (body.claw_id !== invite.claw_id || body.invite_id !== invite.invite_id) {
    return failure("wrong_claw", "redemption is for another claw or invite");
  }
  if (invite.expires_at <= now) {
    return failure("expired", "invite expired");
  }
  if ((await inviteSecretHash(proofKey)) !== invite.secret_hash) {
    return failure("bad_proof", "stored proof key does not match the invite");
  }
  const expected = await computeRedemptionProof(proofKey, {
    claw_id: body.claw_id,
    invite_id: body.invite_id,
    account_id: body.account_id,
    device_pub: body.device_pub,
    peer_key: body.peer_key,
  });
  if (!equalBytes(hexToBytes(expected), hexToBytes(body.proof))) {
    return failure("bad_proof", "redemption proof does not verify");
  }
  const audience = invite.audience;
  const matches =
    identity.account_id === body.account_id &&
    (audience.kind === "account_id"
      ? audience.value === identity.account_id
      : audience.value === identity.email);
  if (!matches) {
    return failure("audience_mismatch", "redeeming account is not the invite audience");
  }
  return signed;
}
