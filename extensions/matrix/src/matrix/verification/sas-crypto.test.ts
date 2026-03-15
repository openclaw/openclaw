import { describe, expect, it } from "vitest";
import {
  buildMacInfoString,
  buildSasInfoString,
  canonicalJson,
  computeCommitment,
  computeMac,
  computeMacHkdfHmacSha256,
  computeMacHkdfHmacSha256V2,
  computeSasDecimals,
  computeSasEmojis,
  computeSharedSecret,
  decodeUnpaddedBase64,
  deriveSasBytes,
  encodeUnpaddedBase64,
  formatSasEmojis,
  generateX25519KeyPair,
  hkdfSha256,
  SAS_EMOJI_TABLE,
} from "./sas-crypto.js";
import type { VerificationStartContent } from "./types.js";

describe("sas-crypto", () => {
  // -----------------------------------------------------------------------
  // Base64 helpers
  // -----------------------------------------------------------------------

  describe("encodeUnpaddedBase64 / decodeUnpaddedBase64", () => {
    it("round-trips binary data without padding", () => {
      const original = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
      const encoded = encodeUnpaddedBase64(original);
      expect(encoded).not.toContain("=");
      const decoded = decodeUnpaddedBase64(encoded);
      expect(Buffer.compare(decoded, original)).toBe(0);
    });

    it("handles empty buffer", () => {
      const encoded = encodeUnpaddedBase64(Buffer.alloc(0));
      expect(encoded).toBe("");
      const decoded = decodeUnpaddedBase64("");
      expect(decoded.length).toBe(0);
    });

    it("handles 32-byte key (typical for X25519)", () => {
      const key = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) {
        key[i] = i;
      }
      const encoded = encodeUnpaddedBase64(key);
      const decoded = decodeUnpaddedBase64(encoded);
      expect(Buffer.compare(decoded, key)).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Canonical JSON
  // -----------------------------------------------------------------------

  describe("canonicalJson", () => {
    it("sorts object keys alphabetically", () => {
      const result = canonicalJson({ z: 1, a: 2, m: 3 });
      expect(result).toBe('{"a":2,"m":3,"z":1}');
    });

    it("handles nested objects", () => {
      const result = canonicalJson({ b: { d: 1, c: 2 }, a: 3 });
      expect(result).toBe('{"a":3,"b":{"c":2,"d":1}}');
    });

    it("handles arrays", () => {
      const result = canonicalJson([3, 1, 2]);
      expect(result).toBe("[3,1,2]");
    });

    it("handles strings with special characters", () => {
      const result = canonicalJson({ key: 'hello "world"' });
      expect(result).toBe('{"key":"hello \\"world\\""}');
    });

    it("handles null and booleans", () => {
      expect(canonicalJson(null)).toBe("null");
      expect(canonicalJson(true)).toBe("true");
      expect(canonicalJson(false)).toBe("false");
    });
  });

  // -----------------------------------------------------------------------
  // X25519 key pair generation
  // -----------------------------------------------------------------------

  describe("generateX25519KeyPair", () => {
    it("generates a key pair with 32-byte keys", () => {
      const keyPair = generateX25519KeyPair();
      expect(keyPair.publicKey.length).toBe(32);
      expect(keyPair.privateKey.length).toBe(32);
    });

    it("generates different key pairs each time", () => {
      const kp1 = generateX25519KeyPair();
      const kp2 = generateX25519KeyPair();
      expect(Buffer.compare(kp1.publicKey, kp2.publicKey)).not.toBe(0);
      expect(Buffer.compare(kp1.privateKey, kp2.privateKey)).not.toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // ECDH shared secret computation
  // -----------------------------------------------------------------------

  describe("computeSharedSecret", () => {
    it("computes a 32-byte shared secret", () => {
      const alice = generateX25519KeyPair();
      const bob = generateX25519KeyPair();

      const secret = computeSharedSecret(alice.privateKey, bob.publicKey);
      expect(secret.length).toBe(32);
    });

    it("computes the same secret from both sides (ECDH symmetry)", () => {
      const alice = generateX25519KeyPair();
      const bob = generateX25519KeyPair();

      const secretA = computeSharedSecret(alice.privateKey, bob.publicKey);
      const secretB = computeSharedSecret(bob.privateKey, alice.publicKey);

      expect(Buffer.compare(secretA, secretB)).toBe(0);
    });

    it("computes different secrets with different key pairs", () => {
      const alice = generateX25519KeyPair();
      const bob = generateX25519KeyPair();
      const charlie = generateX25519KeyPair();

      const secretAB = computeSharedSecret(alice.privateKey, bob.publicKey);
      const secretAC = computeSharedSecret(alice.privateKey, charlie.publicKey);

      expect(Buffer.compare(secretAB, secretAC)).not.toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // HKDF derivation
  // -----------------------------------------------------------------------

  describe("hkdfSha256", () => {
    it("derives the requested number of bytes", () => {
      const ikm = Buffer.from("input key material");
      const result6 = hkdfSha256(ikm, undefined, "info", 6);
      expect(result6.length).toBe(6);

      const result32 = hkdfSha256(ikm, undefined, "info", 32);
      expect(result32.length).toBe(32);

      const result64 = hkdfSha256(ikm, undefined, "info", 64);
      expect(result64.length).toBe(64);
    });

    it("produces deterministic output", () => {
      const ikm = Buffer.from("test key");
      const result1 = hkdfSha256(ikm, undefined, "test info", 32);
      const result2 = hkdfSha256(ikm, undefined, "test info", 32);
      expect(Buffer.compare(result1, result2)).toBe(0);
    });

    it("produces different output for different info strings", () => {
      const ikm = Buffer.from("test key");
      const result1 = hkdfSha256(ikm, undefined, "info A", 32);
      const result2 = hkdfSha256(ikm, undefined, "info B", 32);
      expect(Buffer.compare(result1, result2)).not.toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // SAS info string
  // -----------------------------------------------------------------------

  describe("buildSasInfoString", () => {
    it("builds correctly formatted info string", () => {
      const result = buildSasInfoString({
        senderUserId: "@alice:example.org",
        senderDeviceId: "ALICEDEV",
        senderKey: "aliceKey123",
        receiverUserId: "@bob:example.org",
        receiverDeviceId: "BOBDEV",
        receiverKey: "bobKey456",
        transactionId: "$txn123",
      });
      expect(result).toBe(
        "MATRIX_KEY_VERIFICATION_SAS|@alice:example.org|ALICEDEV|aliceKey123|@bob:example.org|BOBDEV|bobKey456|$txn123",
      );
    });
  });

  describe("buildMacInfoString", () => {
    it("builds correctly formatted MAC info string", () => {
      const result = buildMacInfoString({
        senderUserId: "@alice:example.org",
        senderDeviceId: "ALICEDEV",
        senderKey: "aliceKey123",
        receiverUserId: "@bob:example.org",
        receiverDeviceId: "BOBDEV",
        receiverKey: "bobKey456",
        transactionId: "$txn123",
      });
      expect(result).toBe(
        "MATRIX_KEY_VERIFICATION_MAC|@alice:example.org|ALICEDEV|aliceKey123|@bob:example.org|BOBDEV|bobKey456|$txn123",
      );
    });
  });

  // -----------------------------------------------------------------------
  // SAS byte derivation
  // -----------------------------------------------------------------------

  describe("deriveSasBytes", () => {
    it("derives 6 bytes for emoji mode", () => {
      const secret = Buffer.from("shared secret for testing purposes");
      const sasBytes = deriveSasBytes(secret, "test info", 6);
      expect(sasBytes.length).toBe(6);
    });

    it("derives 5 bytes for decimal mode", () => {
      const secret = Buffer.from("shared secret for testing purposes");
      const sasBytes = deriveSasBytes(secret, "test info", 5);
      expect(sasBytes.length).toBe(5);
    });

    it("is deterministic for same inputs", () => {
      const secret = Buffer.from("deterministic test");
      const info = "MATRIX_KEY_VERIFICATION_SAS|test";
      const bytes1 = deriveSasBytes(secret, info, 6);
      const bytes2 = deriveSasBytes(secret, info, 6);
      expect(Buffer.compare(bytes1, bytes2)).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Commitment hash
  // -----------------------------------------------------------------------

  describe("computeCommitment", () => {
    it("produces a base64 hash from pubkey and start content", () => {
      const pubKey = encodeUnpaddedBase64(Buffer.from("fakepublickey000fakepublickey000"));
      const startContent: VerificationStartContent = {
        from_device: "ALICEDEV",
        method: "m.sas.v1",
        key_agreement_protocols: ["curve25519-hkdf-sha256"],
        hashes: ["sha256"],
        message_authentication_codes: ["hkdf-hmac-sha256.v2"],
        short_authentication_string: ["emoji", "decimal"],
      };
      const commitment = computeCommitment(pubKey, startContent);
      expect(typeof commitment).toBe("string");
      expect(commitment.length).toBeGreaterThan(0);
      // Should not contain padding
      expect(commitment).not.toContain("=");
    });

    it("is deterministic", () => {
      const pubKey = encodeUnpaddedBase64(Buffer.from("testkey00000testkey00000testkey0"));
      const startContent: VerificationStartContent = {
        from_device: "DEV1",
        method: "m.sas.v1",
        key_agreement_protocols: ["curve25519-hkdf-sha256"],
        hashes: ["sha256"],
        message_authentication_codes: ["hkdf-hmac-sha256.v2"],
        short_authentication_string: ["emoji"],
      };
      const c1 = computeCommitment(pubKey, startContent);
      const c2 = computeCommitment(pubKey, startContent);
      expect(c1).toBe(c2);
    });

    it("changes when start content changes", () => {
      const pubKey = encodeUnpaddedBase64(Buffer.from("testkey00000testkey00000testkey0"));
      const content1: VerificationStartContent = {
        from_device: "DEV1",
        method: "m.sas.v1",
        key_agreement_protocols: ["curve25519-hkdf-sha256"],
        hashes: ["sha256"],
        message_authentication_codes: ["hkdf-hmac-sha256.v2"],
        short_authentication_string: ["emoji"],
      };
      const content2: VerificationStartContent = {
        ...content1,
        from_device: "DEV2",
      };
      const c1 = computeCommitment(pubKey, content1);
      const c2 = computeCommitment(pubKey, content2);
      expect(c1).not.toBe(c2);
    });
  });

  // -----------------------------------------------------------------------
  // MAC computation
  // -----------------------------------------------------------------------

  describe("MAC computation", () => {
    const sharedSecret = Buffer.from("shared secret for MAC testing!!");
    const info = "MATRIX_KEY_VERIFICATION_MAC|@a:x|D1|k1|@b:x|D2|k2|$txn";
    const input = "ed25519:DEVICEID";

    it("computeMacHkdfHmacSha256V2 produces a base64 MAC", () => {
      const mac = computeMacHkdfHmacSha256V2(sharedSecret, info, input);
      expect(typeof mac).toBe("string");
      expect(mac.length).toBeGreaterThan(0);
      expect(mac).not.toContain("=");
    });

    it("computeMacHkdfHmacSha256 produces a base64 MAC (backwards compat)", () => {
      const mac = computeMacHkdfHmacSha256(sharedSecret, info, input);
      expect(typeof mac).toBe("string");
      expect(mac.length).toBeGreaterThan(0);
    });

    it("computeMac dispatches to v2 for hkdf-hmac-sha256.v2", () => {
      const macV2 = computeMac("hkdf-hmac-sha256.v2", sharedSecret, info, input);
      const macDirect = computeMacHkdfHmacSha256V2(sharedSecret, info, input);
      expect(macV2).toBe(macDirect);
    });

    it("computeMac dispatches to v1 for hkdf-hmac-sha256", () => {
      const macV1 = computeMac("hkdf-hmac-sha256", sharedSecret, info, input);
      const macDirect = computeMacHkdfHmacSha256(sharedSecret, info, input);
      expect(macV1).toBe(macDirect);
    });

    it("computeMac throws for unsupported method", () => {
      expect(() => computeMac("unsupported-method", sharedSecret, info, input)).toThrow(
        "Unsupported MAC method",
      );
    });

    it("MAC is deterministic", () => {
      const mac1 = computeMacHkdfHmacSha256V2(sharedSecret, info, input);
      const mac2 = computeMacHkdfHmacSha256V2(sharedSecret, info, input);
      expect(mac1).toBe(mac2);
    });

    it("MAC changes with different input", () => {
      const mac1 = computeMacHkdfHmacSha256V2(sharedSecret, info, "input1");
      const mac2 = computeMacHkdfHmacSha256V2(sharedSecret, info, "input2");
      expect(mac1).not.toBe(mac2);
    });

    it("MAC changes with different info", () => {
      const mac1 = computeMacHkdfHmacSha256V2(sharedSecret, "info1", input);
      const mac2 = computeMacHkdfHmacSha256V2(sharedSecret, "info2", input);
      expect(mac1).not.toBe(mac2);
    });
  });

  // -----------------------------------------------------------------------
  // SAS emoji computation
  // -----------------------------------------------------------------------

  describe("computeSasEmojis", () => {
    it("returns 7 emojis from 6 bytes", () => {
      const sasBytes = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      const emojis = computeSasEmojis(sasBytes);
      expect(emojis).toHaveLength(7);
    });

    it("each emoji has emoji and description properties", () => {
      const sasBytes = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
      const emojis = computeSasEmojis(sasBytes);
      for (const emoji of emojis) {
        expect(typeof emoji.emoji).toBe("string");
        expect(typeof emoji.description).toBe("string");
        expect(emoji.emoji.length).toBeGreaterThan(0);
        expect(emoji.description.length).toBeGreaterThan(0);
      }
    });

    it("all zero bytes produce all Dog emojis (index 0)", () => {
      const sasBytes = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      const emojis = computeSasEmojis(sasBytes);
      for (const emoji of emojis) {
        expect(emoji.description).toBe("Dog");
      }
    });

    it("all 0xFF bytes produce all Pin emojis (index 63)", () => {
      const sasBytes = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
      const emojis = computeSasEmojis(sasBytes);
      for (const emoji of emojis) {
        expect(emoji.description).toBe("Pin");
      }
    });

    it("throws for fewer than 6 bytes", () => {
      expect(() => computeSasEmojis(Buffer.from([0x01, 0x02]))).toThrow(
        "SAS bytes must be at least 6 bytes",
      );
    });

    it("is deterministic", () => {
      const sasBytes = Buffer.from([0xab, 0xcd, 0xef, 0x12, 0x34, 0x56]);
      const emojis1 = computeSasEmojis(sasBytes);
      const emojis2 = computeSasEmojis(sasBytes);
      expect(emojis1).toEqual(emojis2);
    });
  });

  // -----------------------------------------------------------------------
  // SAS decimal computation
  // -----------------------------------------------------------------------

  describe("computeSasDecimals", () => {
    it("returns 3 numbers from 5 bytes", () => {
      const sasBytes = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a]);
      const decimals = computeSasDecimals(sasBytes);
      expect(decimals).toHaveLength(3);
    });

    it("each decimal is in range 1000-9191", () => {
      const sasBytes = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]);
      const decimals = computeSasDecimals(sasBytes);
      for (const d of decimals) {
        expect(d).toBeGreaterThanOrEqual(1000);
        expect(d).toBeLessThanOrEqual(9191);
      }
    });

    it("all zero bytes produce minimum decimals (1000)", () => {
      const sasBytes = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]);
      const decimals = computeSasDecimals(sasBytes);
      for (const d of decimals) {
        expect(d).toBe(1000);
      }
    });

    it("throws for fewer than 5 bytes", () => {
      expect(() => computeSasDecimals(Buffer.from([0x01]))).toThrow(
        "SAS bytes must be at least 5 bytes for decimals",
      );
    });
  });

  // -----------------------------------------------------------------------
  // Emoji table
  // -----------------------------------------------------------------------

  describe("SAS_EMOJI_TABLE", () => {
    it("has exactly 64 entries", () => {
      expect(SAS_EMOJI_TABLE).toHaveLength(64);
    });

    it("each entry has emoji and description", () => {
      for (const entry of SAS_EMOJI_TABLE) {
        expect(typeof entry.emoji).toBe("string");
        expect(typeof entry.description).toBe("string");
      }
    });
  });

  // -----------------------------------------------------------------------
  // formatSasEmojis
  // -----------------------------------------------------------------------

  describe("formatSasEmojis", () => {
    it("formats emojis with descriptions", () => {
      const emojis = [
        { emoji: "\u{1F436}", description: "Dog" },
        { emoji: "\u{1F431}", description: "Cat" },
      ];
      const result = formatSasEmojis(emojis);
      expect(result).toContain("Dog");
      expect(result).toContain("Cat");
      expect(result).toContain("\u{1F436}");
      expect(result).toContain("\u{1F431}");
    });
  });

  // -----------------------------------------------------------------------
  // End-to-end: full ECDH + SAS flow
  // -----------------------------------------------------------------------

  describe("end-to-end SAS flow", () => {
    it("two parties derive the same SAS emojis", () => {
      const alice = generateX25519KeyPair();
      const bob = generateX25519KeyPair();

      const aliceSecret = computeSharedSecret(alice.privateKey, bob.publicKey);
      const bobSecret = computeSharedSecret(bob.privateKey, alice.publicKey);

      const alicePubB64 = encodeUnpaddedBase64(alice.publicKey);
      const bobPubB64 = encodeUnpaddedBase64(bob.publicKey);

      const infoString = buildSasInfoString({
        senderUserId: "@alice:example.org",
        senderDeviceId: "ALICEDEV",
        senderKey: alicePubB64,
        receiverUserId: "@bob:example.org",
        receiverDeviceId: "BOBDEV",
        receiverKey: bobPubB64,
        transactionId: "$txn1",
      });

      const aliceSasBytes = deriveSasBytes(aliceSecret, infoString, 6);
      const bobSasBytes = deriveSasBytes(bobSecret, infoString, 6);

      expect(Buffer.compare(aliceSasBytes, bobSasBytes)).toBe(0);

      const aliceEmojis = computeSasEmojis(aliceSasBytes);
      const bobEmojis = computeSasEmojis(bobSasBytes);

      expect(aliceEmojis).toEqual(bobEmojis);
    });

    it("two parties can verify MACs of each other", () => {
      const alice = generateX25519KeyPair();
      const bob = generateX25519KeyPair();

      const sharedSecret = computeSharedSecret(alice.privateKey, bob.publicKey);
      const alicePubB64 = encodeUnpaddedBase64(alice.publicKey);
      const bobPubB64 = encodeUnpaddedBase64(bob.publicKey);

      // Alice sends MAC
      const aliceMacInfo = buildMacInfoString({
        senderUserId: "@alice:example.org",
        senderDeviceId: "ALICEDEV",
        senderKey: alicePubB64,
        receiverUserId: "@bob:example.org",
        receiverDeviceId: "BOBDEV",
        receiverKey: bobPubB64,
        transactionId: "$txn1",
      });

      const aliceKeyId = "ed25519:ALICEDEV";
      const aliceSigningKey = "fakeAliceSigningKeyBase64";

      const aliceMac = computeMac(
        "hkdf-hmac-sha256.v2",
        sharedSecret,
        aliceMacInfo + aliceKeyId,
        aliceSigningKey,
      );

      // Bob verifies Alice's MAC using the same shared secret
      const bobVerifyMac = computeMac(
        "hkdf-hmac-sha256.v2",
        sharedSecret,
        aliceMacInfo + aliceKeyId,
        aliceSigningKey,
      );

      expect(aliceMac).toBe(bobVerifyMac);
    });
  });
});
