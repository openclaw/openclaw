/**
 * Low-level SAS (Short Authentication String) cryptographic operations.
 *
 * Uses Node.js built-in `crypto` module (Node 22+ supports X25519 natively).
 * Implements the Matrix SAS verification protocol as defined in the spec:
 * https://spec.matrix.org/v1.8/client-server-api/#short-authentication-string-sas-verification
 */

import crypto from "node:crypto";
import type { VerificationStartContent } from "./types.js";

// ---------------------------------------------------------------------------
// Base64 helpers (unpadded, as required by Matrix spec)
// ---------------------------------------------------------------------------

export function encodeUnpaddedBase64(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "");
}

export function decodeUnpaddedBase64(str: string): Buffer {
  // Re-add padding for Node's base64 decoder
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

// ---------------------------------------------------------------------------
// Canonical JSON (Matrix spec: sorted keys, no insignificant whitespace)
// ---------------------------------------------------------------------------

export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return "null";
  }
  if (typeof obj === "boolean" || typeof obj === "number") {
    return JSON.stringify(obj);
  }
  if (typeof obj === "string") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    const items = obj.map((item) => canonicalJson(item));
    return `[${items.join(",")}]`;
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    const pairs = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((obj as Record<string, unknown>)[key])}`,
    );
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// X25519 key pair generation and ECDH
// ---------------------------------------------------------------------------

export type X25519KeyPair = {
  publicKey: Buffer;
  privateKey: Buffer;
};

/**
 * Generate an ephemeral X25519 key pair for SAS verification.
 */
export function generateX25519KeyPair(): X25519KeyPair {
  const keyPair = crypto.generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  // Extract raw 32-byte keys from DER encoding
  // X25519 SPKI DER: 12-byte header + 32 bytes of public key
  const publicKey = Buffer.from(keyPair.publicKey.subarray(keyPair.publicKey.length - 32));
  // X25519 PKCS8 DER: 16-byte header + 32 bytes of private key
  const privateKey = Buffer.from(keyPair.privateKey.subarray(keyPair.privateKey.length - 32));

  return { publicKey, privateKey };
}

/**
 * Perform X25519 ECDH to compute a shared secret.
 */
export function computeSharedSecret(ourPrivateKey: Buffer, theirPublicKey: Buffer): Buffer {
  // Import our private key as a CryptoKey
  // Build PKCS8 DER for X25519 private key
  const pkcs8Header = Buffer.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8Der = Buffer.concat([pkcs8Header, ourPrivateKey]);
  const privateKeyObj = crypto.createPrivateKey({
    key: pkcs8Der,
    format: "der",
    type: "pkcs8",
  });

  // Build SPKI DER for X25519 public key
  const spkiHeader = Buffer.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
  ]);
  const spkiDer = Buffer.concat([spkiHeader, theirPublicKey]);
  const publicKeyObj = crypto.createPublicKey({
    key: spkiDer,
    format: "der",
    type: "spki",
  });

  return crypto.diffieHellman({
    privateKey: privateKeyObj,
    publicKey: publicKeyObj,
  });
}

// ---------------------------------------------------------------------------
// HKDF-SHA256
// ---------------------------------------------------------------------------

/**
 * Derive key material using HKDF-SHA256.
 */
export function hkdfSha256(
  ikm: Buffer,
  salt: Buffer | undefined,
  info: string,
  length: number,
): Buffer {
  const effectiveSalt = salt && salt.length > 0 ? salt : Buffer.alloc(32, 0);
  // Extract
  const prk = crypto.createHmac("sha256", effectiveSalt).update(ikm).digest();
  // Expand
  const infoBuffer = Buffer.from(info, "utf-8");
  const n = Math.ceil(length / 32);
  const okm: Buffer[] = [];
  let prev = Buffer.alloc(0);
  for (let i = 1; i <= n; i++) {
    prev = crypto
      .createHmac("sha256", prk)
      .update(Buffer.concat([prev, infoBuffer, Buffer.from([i])]))
      .digest();
    okm.push(prev);
  }
  return Buffer.concat(okm).subarray(0, length);
}

// ---------------------------------------------------------------------------
// SAS info string and SAS byte derivation
// ---------------------------------------------------------------------------

/**
 * Build the SAS info string for key agreement.
 * Format: MATRIX_KEY_VERIFICATION_SAS|senderUserId|senderDeviceId|senderKey|receiverUserId|receiverDeviceId|receiverKey|transactionId
 */
export function buildSasInfoString(params: {
  senderUserId: string;
  senderDeviceId: string;
  senderKey: string;
  receiverUserId: string;
  receiverDeviceId: string;
  receiverKey: string;
  transactionId: string;
}): string {
  return [
    "MATRIX_KEY_VERIFICATION_SAS",
    params.senderUserId,
    params.senderDeviceId,
    params.senderKey,
    params.receiverUserId,
    params.receiverDeviceId,
    params.receiverKey,
    params.transactionId,
  ].join("|");
}

/**
 * Derive SAS bytes from the shared secret using HKDF.
 * Returns 6 bytes for emoji mode or 5 bytes for decimal mode.
 */
export function deriveSasBytes(sharedSecret: Buffer, infoString: string, length: number): Buffer {
  return hkdfSha256(sharedSecret, undefined, infoString, length);
}

// ---------------------------------------------------------------------------
// Commitment hash
// ---------------------------------------------------------------------------

/**
 * Compute the commitment hash for SAS verification.
 * commitment = SHA256(pubkey_base64 || canonical_json(start_content))
 *
 * The pubkey_base64 is the *accepter's* (our) public key, unpadded base64.
 */
export function computeCommitment(
  publicKeyBase64: string,
  startContent: VerificationStartContent,
): string {
  const input = publicKeyBase64 + canonicalJson(startContent);
  const hash = crypto.createHash("sha256").update(input, "utf-8").digest();
  return encodeUnpaddedBase64(hash);
}

// ---------------------------------------------------------------------------
// MAC computation (hkdf-hmac-sha256.v2 and hkdf-hmac-sha256)
// ---------------------------------------------------------------------------

/**
 * Build the MAC info string base.
 * Format: MATRIX_KEY_VERIFICATION_MAC + same params as SAS info
 */
export function buildMacInfoString(params: {
  senderUserId: string;
  senderDeviceId: string;
  senderKey: string;
  receiverUserId: string;
  receiverDeviceId: string;
  receiverKey: string;
  transactionId: string;
}): string {
  return [
    "MATRIX_KEY_VERIFICATION_MAC",
    params.senderUserId,
    params.senderDeviceId,
    params.senderKey,
    params.receiverUserId,
    params.receiverDeviceId,
    params.receiverKey,
    params.transactionId,
  ].join("|");
}

/**
 * Compute a MAC using hkdf-hmac-sha256.v2.
 *
 * 1. Use HKDF with shared secret as IKM and info string as info to derive a 32-byte key.
 * 2. Use HMAC-SHA256 with the derived key to compute the MAC of the input.
 */
export function computeMacHkdfHmacSha256V2(
  sharedSecret: Buffer,
  info: string,
  input: string,
): string {
  const key = hkdfSha256(sharedSecret, undefined, info, 32);
  const mac = crypto.createHmac("sha256", key).update(input, "utf-8").digest();
  return encodeUnpaddedBase64(mac);
}

/**
 * Compute a MAC using hkdf-hmac-sha256 (legacy, for backwards compat).
 *
 * Same as v2 but empty-string input results in MAC of empty string.
 */
export function computeMacHkdfHmacSha256(
  sharedSecret: Buffer,
  info: string,
  input: string,
): string {
  // Same implementation as v2 for actual content
  return computeMacHkdfHmacSha256V2(sharedSecret, info, input);
}

/**
 * Compute MAC using the given method.
 */
export function computeMac(
  method: string,
  sharedSecret: Buffer,
  info: string,
  input: string,
): string {
  if (method === "hkdf-hmac-sha256.v2" || method === "hkdf-hmac-sha256") {
    return computeMacHkdfHmacSha256V2(sharedSecret, info, input);
  }
  throw new Error(`Unsupported MAC method: ${method}`);
}

// ---------------------------------------------------------------------------
// SAS emoji table (Matrix spec v1.8)
// https://spec.matrix.org/v1.8/client-server-api/#sas-method-emoji
// ---------------------------------------------------------------------------

export type SasEmoji = {
  emoji: string;
  description: string;
};

const SAS_EMOJI_TABLE: SasEmoji[] = [
  { emoji: "\u{1F436}", description: "Dog" }, // 0
  { emoji: "\u{1F431}", description: "Cat" }, // 1
  { emoji: "\u{1F981}", description: "Lion" }, // 2
  { emoji: "\u{1F40E}", description: "Horse" }, // 3
  { emoji: "\u{1F984}", description: "Unicorn" }, // 4
  { emoji: "\u{1F437}", description: "Pig" }, // 5
  { emoji: "\u{1F418}", description: "Elephant" }, // 6
  { emoji: "\u{1F430}", description: "Rabbit" }, // 7
  { emoji: "\u{1F43C}", description: "Panda" }, // 8
  { emoji: "\u{1F413}", description: "Rooster" }, // 9
  { emoji: "\u{1F427}", description: "Penguin" }, // 10
  { emoji: "\u{1F422}", description: "Turtle" }, // 11
  { emoji: "\u{1F41F}", description: "Fish" }, // 12
  { emoji: "\u{1F419}", description: "Octopus" }, // 13
  { emoji: "\u{1F98B}", description: "Butterfly" }, // 14
  { emoji: "\u{1F337}", description: "Flower" }, // 15
  { emoji: "\u{1F333}", description: "Tree" }, // 16
  { emoji: "\u{1F335}", description: "Cactus" }, // 17
  { emoji: "\u{1F344}", description: "Mushroom" }, // 18
  { emoji: "\u{1F30F}", description: "Globe" }, // 19
  { emoji: "\u{1F319}", description: "Moon" }, // 20
  { emoji: "\u{2601}\uFE0F", description: "Cloud" }, // 21
  { emoji: "\u{1F525}", description: "Fire" }, // 22
  { emoji: "\u{1F34C}", description: "Banana" }, // 23
  { emoji: "\u{1F34E}", description: "Apple" }, // 24
  { emoji: "\u{1F353}", description: "Strawberry" }, // 25
  { emoji: "\u{1F33D}", description: "Corn" }, // 26
  { emoji: "\u{1F355}", description: "Pizza" }, // 27
  { emoji: "\u{1F382}", description: "Cake" }, // 28
  { emoji: "\u{2764}\uFE0F", description: "Heart" }, // 29
  { emoji: "\u{1F600}", description: "Smiley" }, // 30
  { emoji: "\u{1F916}", description: "Robot" }, // 31
  { emoji: "\u{1F3A9}", description: "Hat" }, // 32
  { emoji: "\u{1F453}", description: "Glasses" }, // 33
  { emoji: "\u{1F527}", description: "Spanner" }, // 34
  { emoji: "\u{1F385}", description: "Santa" }, // 35
  { emoji: "\u{1F44D}", description: "Thumbs Up" }, // 36
  { emoji: "\u{2602}\uFE0F", description: "Umbrella" }, // 37
  { emoji: "\u{231B}", description: "Hourglass" }, // 38
  { emoji: "\u{23F0}", description: "Clock" }, // 39
  { emoji: "\u{1F381}", description: "Gift" }, // 40
  { emoji: "\u{1F4A1}", description: "Light Bulb" }, // 41
  { emoji: "\u{1F4D5}", description: "Book" }, // 42
  { emoji: "\u{270F}\uFE0F", description: "Pencil" }, // 43
  { emoji: "\u{1F4CE}", description: "Paperclip" }, // 44
  { emoji: "\u{2702}\uFE0F", description: "Scissors" }, // 45
  { emoji: "\u{1F512}", description: "Lock" }, // 46
  { emoji: "\u{1F511}", description: "Key" }, // 47
  { emoji: "\u{1F528}", description: "Hammer" }, // 48
  { emoji: "\u{260E}\uFE0F", description: "Telephone" }, // 49
  { emoji: "\u{1F3C1}", description: "Flag" }, // 50
  { emoji: "\u{1F682}", description: "Train" }, // 51
  { emoji: "\u{1F6B2}", description: "Bicycle" }, // 52
  { emoji: "\u{2708}\uFE0F", description: "Aeroplane" }, // 53
  { emoji: "\u{1F680}", description: "Rocket" }, // 54
  { emoji: "\u{1F3C6}", description: "Trophy" }, // 55
  { emoji: "\u{26BD}", description: "Ball" }, // 56
  { emoji: "\u{1F3B8}", description: "Guitar" }, // 57
  { emoji: "\u{1F3BA}", description: "Trumpet" }, // 58
  { emoji: "\u{1F514}", description: "Bell" }, // 59
  { emoji: "\u{2693}", description: "Anchor" }, // 60
  { emoji: "\u{1F3A7}", description: "Headphones" }, // 61
  { emoji: "\u{1F4C1}", description: "Folder" }, // 62
  { emoji: "\u{1F4CC}", description: "Pin" }, // 63
];

/**
 * Compute 7 SAS emojis from 6 SAS bytes.
 * Each emoji index uses 6 bits (0-63), total = 42 bits from 6 bytes (48 bits).
 */
export function computeSasEmojis(sasBytes: Buffer): SasEmoji[] {
  if (sasBytes.length < 6) {
    throw new Error(`SAS bytes must be at least 6 bytes, got ${sasBytes.length}`);
  }
  // Convert first 6 bytes to a 48-bit number for easy bit extraction
  const bits =
    (sasBytes[0] << 40) +
    (sasBytes[1] << 32) +
    (sasBytes[2] << 24) +
    (sasBytes[3] << 16) +
    (sasBytes[4] << 8) +
    sasBytes[5];

  // We need BigInt for 48-bit operations since JS bitwise ops are 32-bit
  const bigBits =
    BigInt(sasBytes[0]) * BigInt(2 ** 40) +
    BigInt(sasBytes[1]) * BigInt(2 ** 32) +
    BigInt(sasBytes[2]) * BigInt(2 ** 24) +
    BigInt(sasBytes[3]) * BigInt(2 ** 16) +
    BigInt(sasBytes[4]) * BigInt(2 ** 8) +
    BigInt(sasBytes[5]);

  const emojis: SasEmoji[] = [];
  for (let i = 0; i < 7; i++) {
    // Extract 6 bits starting from the most significant bit
    const shift = BigInt(42 - i * 6);
    const index = Number((bigBits >> shift) & BigInt(0x3f));
    emojis.push(SAS_EMOJI_TABLE[index]);
  }
  return emojis;
}

/**
 * Compute 3 SAS decimals from 5 SAS bytes.
 * Each decimal uses 13 bits, total = 39 bits from 5 bytes (40 bits).
 * Each number is in range 1000-9191 (add 1000 to the 13-bit value).
 */
export function computeSasDecimals(sasBytes: Buffer): [number, number, number] {
  if (sasBytes.length < 5) {
    throw new Error(`SAS bytes must be at least 5 bytes for decimals, got ${sasBytes.length}`);
  }
  const bigBits =
    BigInt(sasBytes[0]) * BigInt(2 ** 32) +
    BigInt(sasBytes[1]) * BigInt(2 ** 24) +
    BigInt(sasBytes[2]) * BigInt(2 ** 16) +
    BigInt(sasBytes[3]) * BigInt(2 ** 8) +
    BigInt(sasBytes[4]);

  const d1 = Number((bigBits >> BigInt(27)) & BigInt(0x1fff)) + 1000;
  const d2 = Number((bigBits >> BigInt(14)) & BigInt(0x1fff)) + 1000;
  const d3 = Number((bigBits >> BigInt(1)) & BigInt(0x1fff)) + 1000;

  return [d1, d2, d3];
}

/**
 * Format SAS emojis as a display string.
 */
export function formatSasEmojis(emojis: SasEmoji[]): string {
  return emojis.map((e) => `${e.emoji} (${e.description})`).join("  ");
}

// Export the emoji table for testing
export { SAS_EMOJI_TABLE };
