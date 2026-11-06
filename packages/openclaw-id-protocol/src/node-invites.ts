// Accountless node invitations. W remains on the node; a link contains no long-lived key.
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
import { hmacSha256, sha256 } from "./crypto.js";
import { INVITE_SECRET_BYTES, inviteSecretHash } from "./invites.js";
import { canonicalize } from "./jcs.js";
import {
  isClawId,
  isKeyFingerprint,
  isRandomId,
  type IrohEndpointKey,
  type KeyFingerprint,
} from "./keys.js";
import type {
  NodeInviteCapBody,
  NodeRedemptionBody,
  SignedStatement,
  UnixSeconds,
} from "./statements/types.js";
import { failure, verifyNodeRedemptionSignature, type VerifyResult } from "./statements/verify.js";

/** Node links default to ten minutes and must never outlive one hour. */
export const DEFAULT_NODE_INVITE_LIFETIME_SECONDS = 600;
export const MAX_NODE_INVITE_LIFETIME_SECONDS = 3600;

/** Shared human comparison code; not a credential or substitute for explicit approval. */
export async function nodeVerificationCode(
  parts: Pick<NodeRedemptionBody, "claw_id" | "invite_id" | "peer_key" | "description">,
): Promise<string> {
  const { claw_id, invite_id, peer_key, description } = parts;
  const digest = await sha256(
    concatBytes(
      utf8("openclaw/node-verification-code/v1\0"),
      utf8(canonicalize({ claw_id, invite_id, peer_key, description })),
    ),
  );
  const value = new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(
    0,
    false,
  );
  return String(value % 1_000_000).padStart(6, "0");
}

/** Node link fields. `relay_url` is a routing hint, not a trust anchor. */
export type NodeJoinLink = {
  invite_id: string;
  secret: Bytes;
  claw_id: string;
  root_fp: KeyFingerprint;
  hostname: string;
  relay_url: string;
};

const HOST_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[0-9]{1,5})?$/;
const LINK_FIELDS = ["i", "c", "r", "h", "relay"];

function validRelay(value: string): boolean {
  if (value.length > 512) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

/** Encodes a fragment-only `openclaw-node://join` link; no secret is sent in an HTTP target. */
export function buildNodeJoinLink(link: NodeJoinLink): string {
  const params = new URLSearchParams({
    i: `${link.invite_id}.${bytesToBase64url(link.secret)}`,
    c: link.claw_id,
    r: link.root_fp.slice(3),
    h: link.hostname,
    relay: link.relay_url,
  });
  const result = `openclaw-node://join#${params}`;
  if (!parseNodeJoinLink(result)) {
    throw new Error("invalid node join link");
  }
  return result;
}

/** Strict CLI/deep-link decoder: no extra fields, duplicates, credentials, paths or query. */
export function parseNodeJoinLink(value: string): NodeJoinLink | null {
  if (value.length > 2048) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "openclaw-node:" ||
      url.host !== "join" ||
      url.pathname ||
      url.search ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const params = new URLSearchParams(url.hash.slice(1));
    if (
      [...params.keys()].length !== LINK_FIELDS.length ||
      LINK_FIELDS.some((field) => params.getAll(field).length !== 1)
    ) {
      return null;
    }
    const parts = (params.get("i") ?? "").split(".");
    const [invite_id, secretText] = parts;
    const claw_id = params.get("c");
    const root_fp = `fp:${params.get("r") ?? ""}`;
    const hostname = params.get("h") ?? "";
    const relay_url = params.get("relay") ?? "";
    if (
      parts.length !== 2 ||
      !isRandomId(invite_id) ||
      !secretText ||
      !isClawId(claw_id) ||
      !isKeyFingerprint(root_fp) ||
      !HOST_RE.test(hostname) ||
      !validRelay(relay_url)
    ) {
      return null;
    }
    const secret = base64urlToBytes(secretText);
    if (secret.length !== INVITE_SECRET_BYTES) {
      return null;
    }
    return { invite_id, secret, claw_id, root_fp, hostname, relay_url };
  } catch {
    return null;
  }
}

/** Fields authenticated by the node invite proof (distinct from member invite proofs). */
export type NodeRedemptionProofParts = {
  claw_id: string;
  invite_id: string;
  peer_key: IrohEndpointKey;
};

/** HMAC-SHA-256(proof key, `openclaw/node-invite-proof/v1\0` || JCS(parts)), lowercase hex. */
export async function computeNodeRedemptionProof(
  proofKey: Uint8Array,
  parts: NodeRedemptionProofParts,
): Promise<string> {
  return bytesToHex(
    await hmacSha256(
      proofKey,
      concatBytes(utf8("openclaw/node-invite-proof/v1\0"), utf8(canonicalize(parts))),
    ),
  );
}

/** Checks W possession, the matching unexpired invite and proof; success only permits pending. */
export async function verifyNodeRedemption(
  redemption: SignedStatement<"NodeRedemption">,
  invite: NodeInviteCapBody,
  proofKey: Uint8Array,
  now: UnixSeconds,
): Promise<VerifyResult<"NodeRedemption">> {
  const signed = await verifyNodeRedemptionSignature(redemption);
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
  const expected = await computeNodeRedemptionProof(proofKey, {
    claw_id: body.claw_id,
    invite_id: body.invite_id,
    peer_key: body.peer_key,
  });
  if (!equalBytes(hexToBytes(expected), hexToBytes(body.proof))) {
    return failure("bad_proof", "node redemption proof does not verify");
  }
  return signed;
}
