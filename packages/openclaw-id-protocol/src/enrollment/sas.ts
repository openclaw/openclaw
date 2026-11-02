// New-device approval with a short authentication string (owner-key spec section 6.1).
// N = new device, E = existing owner device. Discovery relays the messages and may sit in
// the middle; the commitment stops it from grinding ephemeral keys for a SAS collision.
import {
  bytesToHex,
  concatBytes,
  equalBytes,
  hexToBytes,
  toBytes,
  utf8,
  type Bytes,
} from "../bytes.js";
import { hkdfSha256, randomBytes, sha256 } from "../crypto.js";
import { canonicalize, type JsonValue } from "../jcs.js";

/** Number of SAS digits shown on both screens (~2^-20 per attempt for an active attacker). */
export const SAS_DIGITS = 6;

// PKCS#8 prefix for an X25519 private key (RFC 8410): the 32-byte private key follows.
const X25519_PKCS8_PREFIX = hexToBytes("302e020100300506032b656e04220420");

/** An X25519 ephemeral key pair. `publicKey` is the raw 32 bytes. */
export type EphemeralKey = { privateKey: CryptoKey; publicKey: Bytes };

/** The `start` message fields N commits to (everything but the commitment itself). */
export type SasStart = {
  request_id: string;
  claw_id: string;
  device_pub: string;
  peer_key: string;
  label: string;
};

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

async function importPrivate(raw: Uint8Array): Promise<EphemeralKey> {
  const pkcs8 = concatBytes(X25519_PKCS8_PREFIX, raw);
  const exportable = await subtle().importKey("pkcs8", pkcs8, "X25519", true, ["deriveBits"]);
  const jwk = await subtle().exportKey("jwk", exportable);
  const publicKey = toBytes(
    Uint8Array.from(atob((jwk.x ?? "").replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    ),
  );
  const privateKey = await subtle().importKey("pkcs8", pkcs8, "X25519", false, ["deriveBits"]);
  return { privateKey, publicKey };
}

/** Generates an ephemeral X25519 key. `fromBytes` makes it deterministic (test vectors only). */
export async function generateEphemeralKey(fromBytes?: Uint8Array): Promise<EphemeralKey> {
  return importPrivate(fromBytes ?? randomBytes(32));
}

/** commit = SHA-256(eph_N || JCS(start)). Sent in `start`, before N sees E's key. */
export async function sasCommitment(
  ephemeralPublicN: Uint8Array,
  start: SasStart,
): Promise<string> {
  return bytesToHex(await sha256(concatBytes(ephemeralPublicN, utf8(canonicalize(start)))));
}

/** E's check, on receiving `key`: the revealed eph_N matches the commitment from `start`. */
export async function verifySasCommitment(
  commit: string,
  ephemeralPublicN: Uint8Array,
  start: SasStart,
): Promise<boolean> {
  return equalBytes(hexToBytes(await sasCommitment(ephemeralPublicN, start)), hexToBytes(commit));
}

/** Both sides: ss = X25519(own private, peer public). */
export async function sasSharedSecret(own: EphemeralKey, peerPublic: Uint8Array): Promise<Bytes> {
  const peer = await subtle().importKey("raw", toBytes(peerPublic), "X25519", false, []);
  return new Uint8Array(
    await subtle().deriveBits({ name: "X25519", public: peer }, own.privateKey, 256),
  );
}

/** Transcript T = SHA-256(JCS({ start, commit, eph_e, eph_n, device_pub_e })), covering steps 1-3. */
export async function sasTranscript(parts: {
  start: SasStart;
  commit: string;
  ephemeralPublicE: Uint8Array;
  ephemeralPublicN: Uint8Array;
  devicePubE: string;
}): Promise<Bytes> {
  const transcript: JsonValue = {
    start: parts.start,
    commit: parts.commit,
    eph_e: bytesToHex(parts.ephemeralPublicE),
    eph_n: bytesToHex(parts.ephemeralPublicN),
    device_pub_e: parts.devicePubE,
  };
  return sha256(utf8(canonicalize(transcript)));
}

/** SAS = HKDF(ss, info "openclaw/sas/v1" || hex(T)) as a zero-padded 6-digit decimal. */
export async function sasCode(sharedSecret: Uint8Array, transcript: Uint8Array): Promise<string> {
  const bytes = await hkdfSha256(sharedSecret, "", `openclaw/sas/v1${bytesToHex(transcript)}`, 4);
  const value = new DataView(bytes.buffer).getUint32(0) % 10 ** SAS_DIGITS;
  return value.toString().padStart(SAS_DIGITS, "0");
}

/** AES-256-GCM key for the sealed handoff (step 8): HKDF(ss, info "openclaw/sas-mac/v1" || hex(T)). */
async function sealKey(
  sharedSecret: Uint8Array,
  transcript: Uint8Array,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const raw = await hkdfSha256(
    sharedSecret,
    "",
    `openclaw/sas-mac/v1${bytesToHex(transcript)}`,
    32,
  );
  return subtle().importKey("raw", raw, "AES-GCM", false, [usage]);
}

/** E seals the handoff (R public key, binding + chain, epoch, N's certificate) for N. */
export async function sealHandoff(
  sharedSecret: Uint8Array,
  transcript: Uint8Array,
  handoff: JsonValue,
): Promise<{ nonce: string; ciphertext: string }> {
  const nonce = randomBytes(12);
  const key = await sealKey(sharedSecret, transcript, "encrypt");
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    utf8(canonicalize(handoff)),
  );
  return { nonce: bytesToHex(nonce), ciphertext: bytesToHex(new Uint8Array(ciphertext)) };
}

/** N opens the handoff. Returns null when it was not sealed under this transcript. */
export async function openHandoff(
  sharedSecret: Uint8Array,
  transcript: Uint8Array,
  sealed: { nonce: string; ciphertext: string },
): Promise<unknown> {
  try {
    const key = await sealKey(sharedSecret, transcript, "decrypt");
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv: hexToBytes(sealed.nonce) },
      key,
      hexToBytes(sealed.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as unknown;
  } catch {
    return null;
  }
}
