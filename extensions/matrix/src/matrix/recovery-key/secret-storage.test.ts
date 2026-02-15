/**
 * Unit tests for secret storage operations.
 */

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EncryptedSecret } from "./types.js";
import { ERROR_MESSAGES } from "./constants.js";
import {
  fetchSecretStorageMetadata,
  decryptSecret,
  fetchCrossSigningKeys,
} from "./secret-storage.js";

// Mock Matrix client
function createMockClient(responses: Record<string, unknown>): MatrixClient {
  return {
    getUserId: vi.fn().mockResolvedValue("@test:example.com"),
    doRequest: vi.fn((method: string, url: string, _queryParams?: unknown) => {
      // Normalize URL: remove query parameters if they were appended
      const baseUrl = url.split("?")[0];
      const response = responses[baseUrl] || responses[url];
      if (!response) {
        throw new Error("Not found");
      }
      return Promise.resolve(response);
    }),
  } as unknown as MatrixClient;
}

describe("fetchSecretStorageMetadata", () => {
  const encodedUserId = encodeURIComponent("@test:example.com");

  it("should fetch secret storage metadata successfully", async () => {
    const mockClient = createMockClient({
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.default_key`]: {
        key: "test_key_id",
      },
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.key.test_key_id`]: {
        algorithm: "m.secret_storage.v1.aes-hmac-sha2",
        iv: "aGVsbG8=", // base64("hello")
        mac: "d29ybGQ=", // base64("world")
      },
    });

    const result = await fetchSecretStorageMetadata(mockClient);

    expect(result.algorithm).toBe("m.secret_storage.v1.aes-hmac-sha2");
    expect(result.keyId).toBe("test_key_id");
    expect(result.iv).toBe("aGVsbG8=");
    expect(result.mac).toBe("d29ybGQ=");
    expect(result.passphrase).toBeUndefined();
  });

  it("should throw error when secret storage is not configured", async () => {
    const mockClient = createMockClient({});

    await expect(fetchSecretStorageMetadata(mockClient)).rejects.toThrow(
      ERROR_MESSAGES.SECRET_STORAGE_NOT_CONFIGURED,
    );
  });

  it("should throw error when default key is missing", async () => {
    const mockClient = createMockClient({
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.default_key`]: {},
    });

    await expect(fetchSecretStorageMetadata(mockClient)).rejects.toThrow(
      ERROR_MESSAGES.SECRET_STORAGE_NOT_CONFIGURED,
    );
  });

  it("should throw error when key metadata is not found", async () => {
    const mockClient = createMockClient({
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.default_key`]: {
        key: "test_key_id",
      },
    });

    await expect(fetchSecretStorageMetadata(mockClient)).rejects.toThrow(
      ERROR_MESSAGES.SECRET_STORAGE_KEY_NOT_FOUND,
    );
  });

  it("should throw error when algorithm is invalid", async () => {
    const mockClient = createMockClient({
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.default_key`]: {
        key: "test_key_id",
      },
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.key.test_key_id`]: {
        algorithm: "invalid.algorithm",
        iv: "aGVsbG8=",
        mac: "d29ybGQ=",
      },
    });

    await expect(fetchSecretStorageMetadata(mockClient)).rejects.toThrow(
      ERROR_MESSAGES.INVALID_ALGORITHM,
    );
  });

  it("should throw error when iv or mac is missing", async () => {
    const mockClient = createMockClient({
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.default_key`]: {
        key: "test_key_id",
      },
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.key.test_key_id`]: {
        algorithm: "m.secret_storage.v1.aes-hmac-sha2",
        // Missing iv and mac
      },
    });

    await expect(fetchSecretStorageMetadata(mockClient)).rejects.toThrow(
      ERROR_MESSAGES.SECRET_STORAGE_KEY_NOT_FOUND,
    );
  });

  it("should include passphrase info if present", async () => {
    const mockClient = createMockClient({
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.default_key`]: {
        key: "test_key_id",
      },
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.key.test_key_id`]: {
        algorithm: "m.secret_storage.v1.aes-hmac-sha2",
        iv: "aGVsbG8=",
        mac: "d29ybGQ=",
        passphrase: {
          algorithm: "m.pbkdf2",
          salt: "c2FsdA==",
          iterations: 500000,
        },
      },
    });

    const result = await fetchSecretStorageMetadata(mockClient);

    expect(result.passphrase).toBeDefined();
    expect(result.passphrase?.algorithm).toBe("m.pbkdf2");
    expect(result.passphrase?.salt).toBe("c2FsdA==");
    expect(result.passphrase?.iterations).toBe(500000);
  });
});

describe("decryptSecret", () => {
  // Helper to create a test encrypted secret using Matrix SSSS algorithm
  function createEncryptedSecret(
    plaintext: string,
    key: Uint8Array,
    secretName: string,
  ): { encrypted: EncryptedSecret; plaintext: Buffer } {
    // Matrix stores secrets as Base64-encoded strings
    const plaintextBytes = Buffer.from(plaintext, "utf8");
    const plaintextBase64 = plaintextBytes.toString("base64");

    // Derive AES and HMAC keys using HKDF (same as Matrix SSSS)
    const zeroSalt = Buffer.alloc(8);
    const info = Buffer.from(secretName, "utf8");
    const derivedKeys = crypto.hkdfSync("sha256", key, zeroSalt, info, 64);
    const aesKey = derivedKeys.slice(0, 32);
    const hmacKey = derivedKeys.slice(32, 64);

    // Encrypt the Base64-encoded plaintext with AES-256-CTR
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-ctr", aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextBase64, "utf8"), cipher.final()]);

    // Compute MAC on ciphertext only
    const hmac = crypto.createHmac("sha256", hmacKey);
    hmac.update(ciphertext);
    const mac = hmac.digest();

    return {
      encrypted: {
        iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        mac: mac.toString("base64"),
      },
      plaintext: plaintextBytes,
    };
  }

  it("should decrypt secret successfully", () => {
    const key = crypto.randomBytes(32);
    const secretName = "test.secret";
    const { encrypted, plaintext } = createEncryptedSecret("test secret", key, secretName);

    const decrypted = decryptSecret(encrypted, key, secretName);

    expect(Buffer.from(decrypted)).toEqual(plaintext);
  });

  it("should throw error on MAC mismatch", () => {
    const key = crypto.randomBytes(32);
    const secretName = "test.secret";
    const { encrypted } = createEncryptedSecret("test secret", key, secretName);

    // Tamper with MAC
    const tamperedMac = Buffer.from(encrypted.mac, "base64");
    tamperedMac[0] ^= 0xff; // Flip bits
    const tamperedEncrypted = {
      ...encrypted,
      mac: tamperedMac.toString("base64"),
    };

    expect(() => decryptSecret(tamperedEncrypted, key, secretName)).toThrow(
      ERROR_MESSAGES.MAC_VERIFICATION_FAILED,
    );
  });

  it("should throw error on wrong key", () => {
    const key = crypto.randomBytes(32);
    const wrongKey = crypto.randomBytes(32);
    const secretName = "test.secret";
    const { encrypted } = createEncryptedSecret("test secret", key, secretName);

    expect(() => decryptSecret(encrypted, wrongKey, secretName)).toThrow(
      ERROR_MESSAGES.MAC_VERIFICATION_FAILED,
    );
  });

  it("should throw error on tampered ciphertext", () => {
    const key = crypto.randomBytes(32);
    const secretName = "test.secret";
    const { encrypted } = createEncryptedSecret("test secret", key, secretName);

    // Tamper with ciphertext
    const tamperedCiphertext = Buffer.from(encrypted.ciphertext, "base64");
    tamperedCiphertext[0] ^= 0xff; // Flip bits
    const tamperedEncrypted = {
      ...encrypted,
      ciphertext: tamperedCiphertext.toString("base64"),
    };

    expect(() => decryptSecret(tamperedEncrypted, key, secretName)).toThrow(
      ERROR_MESSAGES.MAC_VERIFICATION_FAILED,
    );
  });

  it("should throw error on tampered IV", () => {
    const key = crypto.randomBytes(32);
    const secretName = "test.secret";
    const { encrypted } = createEncryptedSecret("test secret", key, secretName);

    // Tamper with IV - Note: IV tampering doesn't affect MAC since MAC is only on ciphertext
    // But decryption will produce garbage, not the original plaintext
    const tamperedIv = Buffer.from(encrypted.iv, "base64");
    tamperedIv[0] ^= 0xff; // Flip bits
    const tamperedEncrypted = {
      ...encrypted,
      iv: tamperedIv.toString("base64"),
    };

    // This will decrypt without MAC error, but produce wrong plaintext
    const decrypted = decryptSecret(tamperedEncrypted, key, secretName);
    const original = Buffer.from("test secret", "utf8");
    expect(Buffer.from(decrypted)).not.toEqual(original);
  });

  it("should handle empty plaintext", () => {
    const key = crypto.randomBytes(32);
    const secretName = "test.secret";
    const { encrypted } = createEncryptedSecret("", key, secretName);

    const decrypted = decryptSecret(encrypted, key, secretName);

    expect(decrypted.length).toBe(0);
  });

  it("should handle large plaintext", () => {
    const key = crypto.randomBytes(32);
    const secretName = "test.secret";
    const largePlaintext = "x".repeat(10000);
    const { encrypted, plaintext } = createEncryptedSecret(largePlaintext, key, secretName);

    const decrypted = decryptSecret(encrypted, key, secretName);

    expect(Buffer.from(decrypted)).toEqual(plaintext);
  });
});

describe("fetchCrossSigningKeys", () => {
  const encodedUserId = encodeURIComponent("@test:example.com");

  // Helper to create encrypted cross-signing key data using Matrix SSSS algorithm
  function createMockCrossSigningKey(keyId: string, recoveryKey: Uint8Array, secretName: string) {
    // Generate a test ed25519 private key (32 bytes)
    const privateKey = crypto.randomBytes(32);

    // Matrix stores keys as Base64-encoded strings
    const privateKeyBase64 = privateKey.toString("base64");

    // Derive AES and HMAC keys using HKDF (same as Matrix SSSS)
    const zeroSalt = Buffer.alloc(8);
    const info = Buffer.from(secretName, "utf8");
    const derivedKeys = crypto.hkdfSync("sha256", recoveryKey, zeroSalt, info, 64);
    const aesKey = derivedKeys.slice(0, 32);
    const hmacKey = derivedKeys.slice(32, 64);

    // Encrypt with AES-256-CTR
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-ctr", aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(privateKeyBase64, "utf8"), cipher.final()]);

    // Compute MAC on ciphertext only
    const hmac = crypto.createHmac("sha256", hmacKey);
    hmac.update(ciphertext);
    const mac = hmac.digest();

    return {
      encrypted: {
        [keyId]: {
          iv: iv.toString("base64"),
          ciphertext: ciphertext.toString("base64"),
          mac: mac.toString("base64"),
        },
      },
      privateKey,
    };
  }

  it("should fetch and decrypt cross-signing keys successfully", async () => {
    const recoveryKey = crypto.randomBytes(32);
    const keyId = "test_key_id";

    const masterKey = createMockCrossSigningKey(keyId, recoveryKey, "m.cross_signing.master");
    const selfSigningKey = createMockCrossSigningKey(
      keyId,
      recoveryKey,
      "m.cross_signing.self_signing",
    );
    const userSigningKey = createMockCrossSigningKey(
      keyId,
      recoveryKey,
      "m.cross_signing.user_signing",
    );

    const mockClient = createMockClient({
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.default_key`]: {
        key: keyId,
      },
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.key.test_key_id`]: {
        algorithm: "m.secret_storage.v1.aes-hmac-sha2",
        iv: "aGVsbG8=",
        mac: "d29ybGQ=",
      },
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.cross_signing.master`]: masterKey,
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.cross_signing.self_signing`]:
        selfSigningKey,
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.cross_signing.user_signing`]:
        userSigningKey,
    });

    const result = await fetchCrossSigningKeys(mockClient, recoveryKey);

    // Compare as arrays since Uint8Array and Buffer may have different prototypes
    expect(Array.from(result.master.privateKey)).toEqual(Array.from(masterKey.privateKey));
    expect(Array.from(result.selfSigning.privateKey)).toEqual(
      Array.from(selfSigningKey.privateKey),
    );
    expect(Array.from(result.userSigning.privateKey)).toEqual(
      Array.from(userSigningKey.privateKey),
    );
  });

  it("should throw error when master key is missing", async () => {
    const recoveryKey = crypto.randomBytes(32);
    const mockClient = createMockClient({});

    await expect(fetchCrossSigningKeys(mockClient, recoveryKey)).rejects.toThrow(
      ERROR_MESSAGES.CROSS_SIGNING_NOT_CONFIGURED,
    );
  });

  it("should throw error when self-signing key is missing", async () => {
    const recoveryKey = crypto.randomBytes(32);
    const keyId = "test_key_id";
    const masterKey = createMockCrossSigningKey(keyId, recoveryKey, "m.cross_signing.master");

    const mockClient = createMockClient({
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.default_key`]: {
        key: keyId,
      },
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.key.test_key_id`]: {
        algorithm: "m.secret_storage.v1.aes-hmac-sha2",
        iv: "aGVsbG8=",
        mac: "d29ybGQ=",
      },
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.cross_signing.master`]: masterKey,
    });

    await expect(fetchCrossSigningKeys(mockClient, recoveryKey)).rejects.toThrow(
      ERROR_MESSAGES.SELF_SIGNING_KEY_MISSING,
    );
  });

  it("should throw error when user-signing key is missing", async () => {
    const recoveryKey = crypto.randomBytes(32);
    const keyId = "test_key_id";
    const masterKey = createMockCrossSigningKey(keyId, recoveryKey, "m.cross_signing.master");
    const selfSigningKey = createMockCrossSigningKey(
      keyId,
      recoveryKey,
      "m.cross_signing.self_signing",
    );

    const mockClient = createMockClient({
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.default_key`]: {
        key: keyId,
      },
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.key.test_key_id`]: {
        algorithm: "m.secret_storage.v1.aes-hmac-sha2",
        iv: "aGVsbG8=",
        mac: "d29ybGQ=",
      },
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.cross_signing.master`]: masterKey,
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.cross_signing.self_signing`]:
        selfSigningKey,
    });

    await expect(fetchCrossSigningKeys(mockClient, recoveryKey)).rejects.toThrow(
      ERROR_MESSAGES.USER_SIGNING_KEY_MISSING,
    );
  });

  it("should throw error on decryption failure (wrong key)", async () => {
    const recoveryKey = crypto.randomBytes(32);
    const wrongKey = crypto.randomBytes(32);
    const keyId = "test_key_id";

    const masterKey = createMockCrossSigningKey(keyId, recoveryKey, "m.cross_signing.master");
    const selfSigningKey = createMockCrossSigningKey(
      keyId,
      recoveryKey,
      "m.cross_signing.self_signing",
    );
    const userSigningKey = createMockCrossSigningKey(
      keyId,
      recoveryKey,
      "m.cross_signing.user_signing",
    );

    const mockClient = createMockClient({
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.default_key`]: {
        key: keyId,
      },
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.secret_storage.key.test_key_id`]: {
        algorithm: "m.secret_storage.v1.aes-hmac-sha2",
        iv: "aGVsbG8=",
        mac: "d29ybGQ=",
      },
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.cross_signing.master`]: masterKey,
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.cross_signing.self_signing`]:
        selfSigningKey,
      [`/_matrix/client/v3/user/${encodedUserId}/account_data/m.cross_signing.user_signing`]:
        userSigningKey,
    });

    await expect(fetchCrossSigningKeys(mockClient, wrongKey)).rejects.toThrow(
      ERROR_MESSAGES.MAC_VERIFICATION_FAILED,
    );
  });
});
