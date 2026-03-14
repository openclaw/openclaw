import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeRecoveryKey, decryptSSSSSecret } from "./cross-signing.js";

// ---------------------------------------------------------------------------
// Helpers to produce valid test vectors
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let num = BigInt(0);
  for (const b of bytes) num = num * BigInt(256) + BigInt(b);
  let encoded = "";
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    encoded = BASE58_ALPHABET[rem] + encoded;
  }
  for (const b of bytes) {
    if (b === 0) encoded = "1" + encoded;
    else break;
  }
  return encoded;
}

function makeRecoveryKey(seed: Uint8Array): string {
  // 2-byte prefix + 32-byte seed + 1-byte XOR parity
  const raw = new Uint8Array(35);
  raw[0] = 0x8b;
  raw[1] = 0x01;
  raw.set(seed, 2);
  let parity = 0;
  for (let i = 0; i < 34; i++) parity ^= raw[i];
  raw[34] = parity;
  return base58Encode(raw);
}

function encryptSSSSSecret(
  plaintext: string,
  rawKey: Uint8Array,
  secretName: string,
  keyId: string,
): { encrypted: Record<string, { iv: string; ciphertext: string; mac: string }> } {
  // Derive AES/HMAC keys using the same HKDF params as the production code
  const salt = Buffer.alloc(32, 0);
  const derived = crypto.hkdfSync(
    "sha256",
    rawKey,
    salt,
    Buffer.from(secretName, "utf8"),
    64,
  ) as ArrayBuffer;
  const keyBuf = Buffer.from(derived);
  const aesKey = keyBuf.subarray(0, 32);
  const hmacKey = keyBuf.subarray(32, 64);

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-ctr", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const mac = crypto.createHmac("sha256", hmacKey).update(ciphertext).digest("base64");

  return {
    encrypted: {
      [keyId]: {
        iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        mac,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("decodeRecoveryKey", () => {
  it("decodes a valid recovery key and returns 32 raw bytes", () => {
    const seed = crypto.randomBytes(32);
    const key = makeRecoveryKey(seed);
    const decoded = decodeRecoveryKey(key);
    expect(decoded).toHaveLength(32);
    expect(Buffer.from(decoded)).toEqual(seed);
  });

  it("strips spaces before decoding", () => {
    const seed = crypto.randomBytes(32);
    const key = makeRecoveryKey(seed);
    // Add spaces as Element would display them
    const spaced = key.match(/.{1,4}/g)?.join(" ") ?? key;
    const decoded = decodeRecoveryKey(spaced);
    expect(Buffer.from(decoded)).toEqual(seed);
  });

  it("throws on wrong prefix", () => {
    // Build a key with wrong prefix bytes (0x00, 0x00 instead of 0x8B, 0x01)
    const raw = new Uint8Array(35);
    raw[0] = 0x00;
    raw[1] = 0x00;
    const seedBytes = crypto.randomBytes(32);
    for (let i = 0; i < 32; i++) raw[i + 2] = seedBytes[i];
    let parity = 0;
    for (let i = 0; i < 34; i++) parity ^= raw[i];
    raw[34] = parity;
    const encoded = base58Encode(raw);
    expect(() => decodeRecoveryKey(encoded)).toThrow(/prefix/);
  });

  it("throws on bad checksum", () => {
    const seed = crypto.randomBytes(32);
    const key = makeRecoveryKey(seed);
    // Corrupt the last character
    const corrupted = key.slice(0, -1) + (key[key.length - 1] === "A" ? "B" : "A");
    expect(() => decodeRecoveryKey(corrupted)).toThrow();
  });
});

describe("decryptSSSSSecret", () => {
  it("decrypts a secret encrypted with the same key", () => {
    const rawKey = crypto.randomBytes(32);
    const keyId = "test-key-id";
    const secretName = "m.cross_signing.self_signing";
    const plaintext = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // fake base64 seed

    const encrypted = encryptSSSSSecret(plaintext, rawKey, secretName, keyId);
    const result = decryptSSSSSecret(encrypted, rawKey, secretName, keyId);
    expect(result).toBe(plaintext);
  });

  it("throws if the key ID is not present in encrypted data", () => {
    const rawKey = crypto.randomBytes(32);
    const encrypted = {
      encrypted: { "other-key": { iv: "aaa=", ciphertext: "bbb=", mac: "ccc=" } },
    };
    expect(() =>
      decryptSSSSSecret(encrypted, rawKey, "m.cross_signing.self_signing", "missing-key"),
    ).toThrow(/missing-key/);
  });

  it("throws on MAC mismatch (wrong key)", () => {
    const rawKey = crypto.randomBytes(32);
    const wrongKey = crypto.randomBytes(32);
    const keyId = "test-key-id";
    const encrypted = encryptSSSSSecret("secret", rawKey, "m.cross_signing.self_signing", keyId);
    expect(() =>
      decryptSSSSSecret(encrypted, wrongKey, "m.cross_signing.self_signing", keyId),
    ).toThrow(/MAC/);
  });
});
