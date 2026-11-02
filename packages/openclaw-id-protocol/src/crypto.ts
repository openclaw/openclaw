// WebCrypto primitives. This is the only module that touches crypto.subtle, and it works
// unchanged in Node (>= 24), browsers and Workers. No node:crypto on this path.
import { concatBytes, hexToBytes, toBytes, utf8, type Bytes } from "./bytes.js";

/** Signature algorithms a v1-draft envelope may name. Only Ed25519 is implemented. */
export type SignatureAlgorithm = "ed25519";

/** A key that can sign statements. The private key never leaves the object. */
export type StatementSigner = {
  /** Raw 32-byte Ed25519 public key. */
  readonly publicKey: Bytes;
  /** Signs the exact message bytes (the caller builds the domain-separated input). */
  sign(message: Uint8Array): Promise<Bytes>;
};

// PKCS#8 prefix for an Ed25519 private key (RFC 8410): the 32-byte seed follows.
const ED25519_PKCS8_PREFIX = hexToBytes("302e020100300506032b657004220420");

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

/** SHA-256 digest. */
export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().digest("SHA-256", toBytes(data)));
}

/** HMAC-SHA-256. */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const hmacKey = await subtle().importKey(
    "raw",
    toBytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle().sign("HMAC", hmacKey, toBytes(data)));
}

/** HKDF-SHA-256 (RFC 5869) with UTF-8 salt and info strings. */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: string,
  info: string,
  length: number,
): Promise<Bytes> {
  const key = await subtle().importKey("raw", toBytes(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: utf8(salt), info: utf8(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Cryptographically random bytes. */
export function randomBytes(length: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

async function signerFromKeyPair(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<StatementSigner> {
  const raw = new Uint8Array(await subtle().exportKey("raw", publicKey));
  return {
    publicKey: raw,
    async sign(message) {
      return new Uint8Array(await subtle().sign("Ed25519", privateKey, toBytes(message)));
    },
  };
}

/**
 * Imports an Ed25519 signer from a 32-byte seed (used for the kit-derived root R and test vectors).
 * The imported private key is non-extractable.
 */
export async function ed25519SignerFromSeed(seed: Uint8Array): Promise<StatementSigner> {
  if (seed.length !== 32) {
    throw new Error("Ed25519 seed must be 32 bytes");
  }
  const pkcs8 = concatBytes(ED25519_PKCS8_PREFIX, seed);
  // Import once extractable to derive the public key, then keep only a non-extractable copy.
  const exportable = await subtle().importKey("pkcs8", pkcs8, "Ed25519", true, ["sign"]);
  const jwk = await subtle().exportKey("jwk", exportable);
  const publicKey = await subtle().importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: jwk.x, ext: true },
    "Ed25519",
    true,
    ["verify"],
  );
  const privateKey = await subtle().importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
  pkcs8.fill(0);
  return signerFromKeyPair(privateKey, publicKey);
}

/**
 * Generates a fresh Ed25519 signer with a non-extractable private key, as an owner
 * device stores it in IndexedDB. See docs/statements.md for browser support and the
 * P-256 decision point.
 */
export async function generateEd25519Signer(): Promise<StatementSigner> {
  const pair = (await subtle().generateKey("Ed25519", false, ["sign", "verify"])) as {
    privateKey: CryptoKey;
    publicKey: CryptoKey;
  };
  return signerFromKeyPair(pair.privateKey, pair.publicKey);
}

/** Verifies an Ed25519 signature over `message` with a raw 32-byte public key. */
export async function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) {
    return false;
  }
  try {
    const key = await subtle().importKey("raw", toBytes(publicKey), "Ed25519", false, ["verify"]);
    return await subtle().verify("Ed25519", key, toBytes(signature), toBytes(message));
  } catch {
    return false;
  }
}
