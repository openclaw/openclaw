import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret } from "./secret-storage.js";
import type { EncryptedSecret } from "./types.js";

/**
 * Build a known-good SSSS-encrypted secret so we can verify decryptSecret
 * against known inputs without needing a real Matrix homeserver.
 *
 * Uses the same algorithm as the Matrix spec:
 *   HKDF-SHA256(recoveryKey, zeroSalt, secretName) -> aesKey (32) + hmacKey (32)
 *   AES-256-CTR(aesKey, iv) -> ciphertext
 *   HMAC-SHA256(hmacKey, ciphertext) -> mac
 */
function encryptSecret(
  plaintext: Uint8Array,
  recoveryKey: Uint8Array,
  secretName: string,
): EncryptedSecret {
  const zeroSalt = Buffer.alloc(32);
  const info = Buffer.from(secretName, "utf-8");
  const derived = crypto.hkdfSync("sha256", recoveryKey, zeroSalt, info, 64);
  const derivedBuf = Buffer.from(derived);
  const aesKey = derivedBuf.subarray(0, 32);
  const hmacKey = derivedBuf.subarray(32, 64);

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-ctr", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const hmac = crypto.createHmac("sha256", hmacKey);
  hmac.update(ciphertext);
  const mac = hmac.digest();

  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    mac: mac.toString("base64"),
  };
}

describe("decryptSecret", () => {
  const recoveryKey = crypto.randomBytes(32);
  // HKDF info must be the secret's event type (e.g. m.cross_signing.master), not the key ID
  const secretName = "m.cross_signing.master";

  it("round-trips: encrypt then decrypt returns original plaintext", () => {
    const plaintext = Buffer.from("my secret cross-signing key material");
    const encrypted = encryptSecret(plaintext, recoveryKey, secretName);

    const decrypted = decryptSecret(encrypted, recoveryKey, secretName);
    expect(Buffer.from(decrypted).toString()).toBe("my secret cross-signing key material");
  });

  it("decrypts binary data correctly", () => {
    const binaryData = crypto.randomBytes(64);
    const encrypted = encryptSecret(binaryData, recoveryKey, secretName);

    const decrypted = decryptSecret(encrypted, recoveryKey, secretName);
    expect(Buffer.from(decrypted)).toEqual(binaryData);
  });

  it("decrypts single-byte plaintext", () => {
    const plaintext = new Uint8Array([0x42]);
    const encrypted = encryptSecret(plaintext, recoveryKey, secretName);

    const decrypted = decryptSecret(encrypted, recoveryKey, secretName);
    expect(decrypted).toEqual(plaintext);
  });

  it("rejects wrong recovery key (MAC mismatch)", () => {
    const plaintext = Buffer.from("secret");
    const encrypted = encryptSecret(plaintext, recoveryKey, secretName);

    const wrongKey = crypto.randomBytes(32);
    expect(() => decryptSecret(encrypted, wrongKey, secretName)).toThrow("MAC verification failed");
  });

  it("rejects wrong secret name (MAC mismatch)", () => {
    const plaintext = Buffer.from("secret");
    const encrypted = encryptSecret(plaintext, recoveryKey, secretName);

    expect(() => decryptSecret(encrypted, recoveryKey, "m.different.key")).toThrow(
      "MAC verification failed",
    );
  });

  it("rejects tampered ciphertext", () => {
    const plaintext = Buffer.from("secret");
    const encrypted = encryptSecret(plaintext, recoveryKey, secretName);

    // Flip a byte in the ciphertext
    const ctBuf = Buffer.from(encrypted.ciphertext, "base64");
    ctBuf[0] ^= 0xff;
    encrypted.ciphertext = ctBuf.toString("base64");

    expect(() => decryptSecret(encrypted, recoveryKey, secretName)).toThrow(
      "MAC verification failed",
    );
  });

  it("rejects tampered MAC", () => {
    const plaintext = Buffer.from("secret");
    const encrypted = encryptSecret(plaintext, recoveryKey, secretName);

    // Flip a byte in the MAC
    const macBuf = Buffer.from(encrypted.mac, "base64");
    macBuf[0] ^= 0xff;
    encrypted.mac = macBuf.toString("base64");

    expect(() => decryptSecret(encrypted, recoveryKey, secretName)).toThrow(
      "MAC verification failed",
    );
  });

  it("produces different ciphertext for different IVs", () => {
    const plaintext = Buffer.from("same plaintext");
    const enc1 = encryptSecret(plaintext, recoveryKey, secretName);
    const enc2 = encryptSecret(plaintext, recoveryKey, secretName);
    // Random IVs should produce different ciphertexts
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });
});
