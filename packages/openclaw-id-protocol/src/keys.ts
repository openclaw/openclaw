// Key and identifier text formats. All hex is lowercase; one value has one spelling.
import { bytesToCrockford, bytesToHex, hexToBytes, type Bytes } from "./bytes.js";
import { sha256 } from "./crypto.js";

/** Ed25519 signing key (owner root R, owner device D, Gateway key K_gw): `ed25519:<64 hex>`. */
export type Ed25519PublicKey = `ed25519:${string}`;
/** iroh endpoint id (device peer key W, claw server key K_srv): `iroh:<64 hex>`. */
export type IrohEndpointKey = `iroh:${string}`;
/** SHA-256 over the raw 32 public-key bytes: `fp:<64 hex>`. */
export type KeyFingerprint = `fp:${string}`;
/** Any public key that can be fingerprinted. */
export type PublicKeyText = Ed25519PublicKey | IrohEndpointKey;

const ED25519_RE = /^ed25519:[0-9a-f]{64}$/;
const IROH_RE = /^iroh:[0-9a-f]{64}$/;
const FP_RE = /^fp:[0-9a-f]{64}$/;
const CLAW_ID_RE = /^[0-9a-f]{32}$/;
const HEX32_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[0-9a-f]{32}$/;

/** True for `ed25519:<64 lowercase hex>`. */
export function isEd25519PublicKey(value: unknown): value is Ed25519PublicKey {
  return typeof value === "string" && ED25519_RE.test(value);
}

/** True for `iroh:<64 lowercase hex>` (TUNNEL.md decision 1: no z32, no upper case). */
export function isIrohEndpointKey(value: unknown): value is IrohEndpointKey {
  return typeof value === "string" && IROH_RE.test(value);
}

/** True for `fp:<64 lowercase hex>`. */
export function isKeyFingerprint(value: unknown): value is KeyFingerprint {
  return typeof value === "string" && FP_RE.test(value);
}

/** True for a claw id: 128 random bits as 32 lowercase hex characters. */
export function isClawId(value: unknown): value is string {
  return typeof value === "string" && CLAW_ID_RE.test(value);
}

/** True for a 128-bit random identifier (invite_id, request_id) as 32 lowercase hex characters. */
export function isRandomId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

/** True for a SHA-256 digest as 64 lowercase hex characters. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && HEX32_RE.test(value);
}

/** Returns the raw 32 bytes of an `ed25519:` or `iroh:` key. */
export function rawPublicKey(key: PublicKeyText): Bytes {
  if (!isEd25519PublicKey(key) && !isIrohEndpointKey(key)) {
    throw new Error("malformed public key");
  }
  return hexToBytes(key.slice(key.indexOf(":") + 1));
}

/** Formats raw Ed25519 public-key bytes as `ed25519:<hex>`. */
export function formatEd25519PublicKey(raw: Uint8Array): Ed25519PublicKey {
  if (raw.length !== 32) {
    throw new Error("Ed25519 public key must be 32 bytes");
  }
  return `ed25519:${bytesToHex(raw)}`;
}

/** Formats a raw iroh endpoint id (an Ed25519 public key) as `iroh:<hex>`. */
export function formatIrohEndpointKey(raw: Uint8Array): IrohEndpointKey {
  if (raw.length !== 32) {
    throw new Error("iroh endpoint id must be 32 bytes");
  }
  return `iroh:${bytesToHex(raw)}`;
}

/**
 * fp(K) = SHA-256 over the raw public key (owner-key spec section 2).
 *
 * The prefix is not hashed, so `ed25519:X` and `iroh:X` share a fingerprint. That is
 * intended: an iroh endpoint id is an Ed25519 key, and revoking a fingerprint must
 * cover the key whatever role it was presented in.
 */
export async function fingerprint(key: PublicKeyText): Promise<KeyFingerprint> {
  return `fp:${bytesToHex(await sha256(rawPublicKey(key)))}`;
}

/** Human-checkable form of a fingerprint: the first 100 bits as four groups of five Crockford base32 characters. */
export function displayFingerprint(fp: KeyFingerprint): string {
  if (!isKeyFingerprint(fp)) {
    throw new Error("malformed fingerprint");
  }
  const text = bytesToCrockford(hexToBytes(fp.slice(3, 3 + 26))).slice(0, 20);
  return [0, 5, 10, 15].map((start) => text.slice(start, start + 5)).join("-");
}
