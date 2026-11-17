// Recovery kit: secret S, its text encoding, and the derivation of the owner root key R.
import {
  bytesToCrockford,
  concatBytes,
  crockfordToBytes,
  equalBytes,
  type Bytes,
} from "./bytes.js";
import {
  ed25519SignerFromSeed,
  hkdfSha256,
  randomBytes,
  sha256,
  type StatementSigner,
} from "./crypto.js";

/** Kit secret length: 128 bits from a CSPRNG, never user chosen. */
export const KIT_SECRET_BYTES = 16;
/** Version byte of the `OCK1` kit text format. */
export const KIT_FORMAT_VERSION = 1;
/** HKDF salt for the root seed (owner-key spec section 2). */
export const ROOT_SEED_SALT = "openclaw/owner-root/v1";
/** HKDF info for the root seed. */
export const ROOT_SEED_INFO = "ed25519-seed";

const KIT_PREFIX = "OCK1";
// version (1) + S (16) + checksum (2) = 19 bytes = 31 base32 characters.
const KIT_PAYLOAD_BYTES = 1 + KIT_SECRET_BYTES + 2;

/** Generates a new kit secret S. */
export function generateKitSecret(): Bytes {
  return randomBytes(KIT_SECRET_BYTES);
}

/** Derives the Ed25519 seed of R: HKDF-SHA-256(ikm=S, salt, info). No stretching: S has full entropy. */
export async function deriveRootSeed(kitSecret: Uint8Array): Promise<Bytes> {
  if (kitSecret.length !== KIT_SECRET_BYTES) {
    throw new Error("kit secret must be 16 bytes");
  }
  return hkdfSha256(kitSecret, ROOT_SEED_SALT, ROOT_SEED_INFO, 32);
}

/** Derives the root signer R from S. Callers drop the signer when the ceremony ends. */
export async function deriveRootSigner(kitSecret: Uint8Array): Promise<StatementSigner> {
  const seed = await deriveRootSeed(kitSecret);
  try {
    return await ed25519SignerFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}

async function kitChecksum(versionAndSecret: Uint8Array): Promise<Bytes> {
  return (await sha256(versionAndSecret)).slice(0, 2);
}

/** Encodes S as `OCK1-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X` (version, S, 2-byte checksum, Crockford base32). */
export async function encodeKit(kitSecret: Uint8Array): Promise<string> {
  if (kitSecret.length !== KIT_SECRET_BYTES) {
    throw new Error("kit secret must be 16 bytes");
  }
  const body = concatBytes(new Uint8Array([KIT_FORMAT_VERSION]), kitSecret);
  const text = bytesToCrockford(concatBytes(body, await kitChecksum(body)));
  const groups = text.match(/.{1,5}/g) ?? [];
  return [KIT_PREFIX, ...groups].join("-");
}

/** Decodes kit text back to S. Rejects a wrong version or checksum (typing mistakes). */
export async function decodeKit(text: string): Promise<Bytes> {
  const compact = text.trim().replace(/[\s-]/g, "");
  if (!compact.toUpperCase().startsWith(KIT_PREFIX)) {
    throw new Error("not an OCK1 kit");
  }
  const payload = crockfordToBytes(compact.slice(KIT_PREFIX.length), KIT_PAYLOAD_BYTES);
  const body = payload.slice(0, 1 + KIT_SECRET_BYTES);
  if (body[0] !== KIT_FORMAT_VERSION) {
    throw new Error("unsupported kit version");
  }
  if (!equalBytes(payload.slice(1 + KIT_SECRET_BYTES), await kitChecksum(body))) {
    throw new Error("kit checksum mismatch");
  }
  return body.slice(1);
}
