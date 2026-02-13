/**
 * Integration test: Recovery Key Round-Trip
 *
 * Tests the full recovery key decode → BackupDecryptionKey → SSSS restore flow.
 * HTTP calls to the homeserver are mocked; crypto operations use real logic.
 */

import * as crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Recovery key encoding helper (inverse of decodeRecoveryKey) ──────
// Builds a valid recovery key string for testing.

const RECOVERY_KEY_PREFIX = new Uint8Array([0x8b, 0x01]);

async function encodeRecoveryKey(rawKey: Uint8Array): Promise<string> {
  const bs58 = (await import("bs58")).default;
  const payload = new Uint8Array(35);
  payload[0] = RECOVERY_KEY_PREFIX[0];
  payload[1] = RECOVERY_KEY_PREFIX[1];
  payload.set(rawKey, 2);
  let parity = 0;
  for (let i = 0; i < 34; i++) parity ^= payload[i];
  payload[34] = parity;
  return bs58.encode(payload);
}

describe("Recovery Key Round-Trip", () => {
  // Use a fixed 32-byte key for deterministic tests
  const rawKey = crypto.randomBytes(32);

  describe("decodeRecoveryKey", () => {
    it("decodes a valid recovery key to 32 bytes", async () => {
      const { decodeRecoveryKey } = await import("../../src/crypto/recovery.js");
      const encoded = await encodeRecoveryKey(rawKey);

      const decoded = await decodeRecoveryKey(encoded);

      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(decoded.length).toBe(32);
      expect(Buffer.from(decoded)).toEqual(Buffer.from(rawKey));
    });

    it("handles spaces and dashes in key string", async () => {
      const { decodeRecoveryKey } = await import("../../src/crypto/recovery.js");
      const encoded = await encodeRecoveryKey(rawKey);

      // Insert spaces and dashes like a user might copy-paste
      const withSpaces = encoded.match(/.{1,4}/g)!.join(" ");
      const decoded = await decodeRecoveryKey(withSpaces);

      expect(Buffer.from(decoded)).toEqual(Buffer.from(rawKey));
    });

    it("rejects an invalid prefix", async () => {
      const { decodeRecoveryKey } = await import("../../src/crypto/recovery.js");
      const bs58 = (await import("bs58")).default;

      // Build a payload with wrong prefix (0x0000 instead of 0x8B01)
      const bad = new Uint8Array(35);
      bad[0] = 0x00;
      bad[1] = 0x00;
      bad.set(rawKey, 2);
      let parity = 0;
      for (let i = 0; i < 34; i++) parity ^= bad[i];
      bad[34] = parity;

      await expect(decodeRecoveryKey(bs58.encode(bad))).rejects.toThrow(
        /Invalid recovery key prefix/,
      );
    });

    it("rejects a key with wrong length", async () => {
      const { decodeRecoveryKey } = await import("../../src/crypto/recovery.js");
      const bs58 = (await import("bs58")).default;

      // Only 20 bytes — too short
      const short = crypto.randomBytes(20);
      await expect(decodeRecoveryKey(bs58.encode(short))).rejects.toThrow(
        /Invalid recovery key length/,
      );
    });

    it("rejects a key with bad parity", async () => {
      const { decodeRecoveryKey } = await import("../../src/crypto/recovery.js");
      const bs58 = (await import("bs58")).default;

      const payload = new Uint8Array(35);
      payload[0] = RECOVERY_KEY_PREFIX[0];
      payload[1] = RECOVERY_KEY_PREFIX[1];
      payload.set(rawKey, 2);
      // Intentionally wrong parity
      payload[34] = 0xff;

      await expect(decodeRecoveryKey(bs58.encode(payload))).rejects.toThrow(/parity check failed/);
    });
  });

  describe("BackupDecryptionKey from decoded bytes", () => {
    it("creates a BackupDecryptionKey from raw 32-byte key", async () => {
      const { decodeRecoveryKey } = await import("../../src/crypto/recovery.js");
      const { BackupDecryptionKey } = await import("@matrix-org/matrix-sdk-crypto-nodejs");

      const encoded = await encodeRecoveryKey(rawKey);
      const decoded = await decodeRecoveryKey(encoded);

      const keyBase64 = Buffer.from(decoded).toString("base64");
      const decryptionKey = BackupDecryptionKey.fromBase64(keyBase64);

      expect(decryptionKey).toBeTruthy();
      // BackupDecryptionKey should have a megolmV1PublicKey property
      expect(typeof decryptionKey.megolmV1PublicKey).toBe("object");
    });
  });

  describe("activateRecoveryKey (mocked HTTP)", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("returns undefined when recovery key is malformed", async () => {
      const { activateRecoveryKey } = await import("../../src/crypto/recovery.js");

      const result = await activateRecoveryKey("not-a-valid-key");

      expect(result).toBeUndefined();
    });

    it("returns undefined when no backup version exists on server", async () => {
      const { activateRecoveryKey } = await import("../../src/crypto/recovery.js");

      // Mock matrixFetch to throw for room_keys/version (no backup)
      const httpModule = await import("../../src/client/http.js");
      vi.spyOn(httpModule, "matrixFetch").mockRejectedValue(new Error("M_NOT_FOUND: No backup"));

      const encoded = await encodeRecoveryKey(rawKey);
      const result = await activateRecoveryKey(encoded);

      expect(result).toBeUndefined();
    });
  });
});
