// Signed requests to Discovery: the Gateway signs with K_gw, owner/member devices with D.
// No bearer secrets for Gateways; possession of the registered key is the credential.
import {
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  concatBytes,
  utf8,
  type Bytes,
} from "../bytes.js";
import { sha256, verifyEd25519, type StatementSigner } from "../crypto.js";
import { canonicalize } from "../jcs.js";
import {
  formatEd25519PublicKey,
  isEd25519PublicKey,
  rawPublicKey,
  type Ed25519PublicKey,
  type IrohEndpointKey,
} from "../keys.js";

/** Request header carrying the signature. */
export const DISCOVERY_SIGNATURE_HEADER = "openclaw-signature";
/** Accepted clock skew for signed requests, seconds. */
export const DISCOVERY_SIGNATURE_MAX_SKEW = 300;

const REQUEST_DOMAIN = "openclaw/discovery-request/v1\0";
const PEER_KEY_PROOF_DOMAIN = "openclaw/peer-key-proof/v1\0";

/** The parts of an HTTP request covered by the signature. `path` includes the query string. */
export type SignedRequestParts = { method: string; path: string; body: Uint8Array; ts: number };

/** Signing input: domain || JCS({ body_sha256, method, path, ts }). */
export async function discoveryRequestSigningInput(parts: SignedRequestParts): Promise<Bytes> {
  const digest = bytesToHex(await sha256(parts.body));
  return concatBytes(
    utf8(REQUEST_DOMAIN),
    utf8(
      canonicalize({
        body_sha256: digest,
        method: parts.method.toUpperCase(),
        path: parts.path,
        ts: parts.ts,
      }),
    ),
  );
}

/** Returns the `OpenClaw-Signature` header value: `keyid=<ed25519:hex>,ts=<unix>,sig=<base64url>`. */
export async function signDiscoveryRequest(
  parts: SignedRequestParts,
  signer: StatementSigner,
): Promise<string> {
  const sig = await signer.sign(await discoveryRequestSigningInput(parts));
  return `keyid=${formatEd25519PublicKey(signer.publicKey)},ts=${parts.ts},sig=${bytesToBase64url(sig)}`;
}

/** Result of {@link verifyDiscoveryRequest}. */
export type RequestSignatureCheck =
  | { ok: true; keyid: Ed25519PublicKey }
  | { ok: false; code: "unauthorized"; detail: string };

/**
 * Verifies a signed request. The caller then checks that `keyid` is the key it expects
 * (the claw's registered K_gw, or a device key bound to the signed-in account).
 * Replays inside the skew window are possible; endpoints that change state are idempotent
 * or sequence-checked.
 */
export async function verifyDiscoveryRequest(
  parts: Omit<SignedRequestParts, "ts">,
  header: string | null,
  now: number,
): Promise<RequestSignatureCheck> {
  const match = /^keyid=(ed25519:[0-9a-f]{64}),ts=([0-9]{1,12}),sig=([A-Za-z0-9_-]{86})$/.exec(
    header ?? "",
  );
  if (!match) {
    return { ok: false, code: "unauthorized", detail: "missing or malformed signature header" };
  }
  const [, keyid, tsText, sigText] = match as unknown as [string, string, string, string];
  const ts = Number(tsText);
  if (!isEd25519PublicKey(keyid) || Math.abs(now - ts) > DISCOVERY_SIGNATURE_MAX_SKEW) {
    return { ok: false, code: "unauthorized", detail: "stale or invalid signature" };
  }
  const input = await discoveryRequestSigningInput({ ...parts, ts });
  if (!(await verifyEd25519(rawPublicKey(keyid), input, base64urlToBytes(sigText)))) {
    return { ok: false, code: "unauthorized", detail: "signature does not verify" };
  }
  return { ok: true, keyid };
}

/** What a device proves when it binds a peer key W to its account at Discovery. */
export type PeerKeyProofParts = {
  account_id: string;
  device_pub: Ed25519PublicKey;
  peer_key: IrohEndpointKey;
  ts: number;
};

/** Signing input for the W possession proof (signed with the iroh secret key, which is Ed25519). */
export function peerKeyProofInput(parts: PeerKeyProofParts): Bytes {
  return concatBytes(utf8(PEER_KEY_PROOF_DOMAIN), utf8(canonicalize(parts)));
}

/** Verifies a W possession proof (base64url signature by the peer key). */
export async function verifyPeerKeyProof(
  parts: PeerKeyProofParts,
  proof: string,
): Promise<boolean> {
  try {
    return await verifyEd25519(
      rawPublicKey(parts.peer_key),
      peerKeyProofInput(parts),
      base64urlToBytes(proof),
    );
  } catch {
    return false;
  }
}
