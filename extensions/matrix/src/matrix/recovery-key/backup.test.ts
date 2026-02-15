/**
 * Tests for Matrix key backup operations.
 */

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BackupInfo } from "./types.js";
import { getKeyBackupVersion, getBackupDecryptionKey, restoreBackup } from "./backup.js";
import * as secretStorage from "./secret-storage.js";

describe("getKeyBackupVersion", () => {
  let mockClient: MatrixClient;

  beforeEach(() => {
    mockClient = {
      doRequest: vi.fn(),
    } as unknown as MatrixClient;
  });

  it("should return backup info when backup exists", async () => {
    const mockBackupResponse = {
      version: "2",
      algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
      auth_data: {
        public_key: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo",
      },
    };

    vi.spyOn(mockClient, "doRequest").mockResolvedValue(mockBackupResponse);

    const result = await getKeyBackupVersion(mockClient);

    expect(result).toEqual({
      version: "2",
      algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
      authData: {
        public_key: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo",
      },
    });

    expect(mockClient.doRequest).toHaveBeenCalledWith(
      "GET",
      "/_matrix/client/v3/room_keys/version",
    );
  });

  it("should return null when no backup exists (404)", async () => {
    const error = new Error("Not found") as Error & { statusCode?: number };
    error.statusCode = 404;
    vi.spyOn(mockClient, "doRequest").mockRejectedValue(error);

    const result = await getKeyBackupVersion(mockClient);

    expect(result).toBeNull();
  });

  it("should throw error on API failure (500)", async () => {
    const error = new Error("Internal server error") as Error & { statusCode?: number };
    error.statusCode = 500;
    vi.spyOn(mockClient, "doRequest").mockRejectedValue(error);

    await expect(getKeyBackupVersion(mockClient)).rejects.toThrow("Internal server error");
  });

  it("should throw error on network failure", async () => {
    vi.spyOn(mockClient, "doRequest").mockRejectedValue(new Error("Network timeout"));

    await expect(getKeyBackupVersion(mockClient)).rejects.toThrow("Network timeout");
  });

  it("should throw error when response is missing version", async () => {
    const invalidResponse = {
      algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
      // Missing version
    };

    vi.spyOn(mockClient, "doRequest").mockResolvedValue(invalidResponse);

    await expect(getKeyBackupVersion(mockClient)).rejects.toThrow(
      "Invalid backup response: missing version or algorithm",
    );
  });

  it("should throw error when response is missing algorithm", async () => {
    const invalidResponse = {
      version: "2",
      // Missing algorithm
    };

    vi.spyOn(mockClient, "doRequest").mockResolvedValue(invalidResponse);

    await expect(getKeyBackupVersion(mockClient)).rejects.toThrow(
      "Invalid backup response: missing version or algorithm",
    );
  });

  it("should handle backup response without auth_data", async () => {
    const mockBackupResponse = {
      version: "2",
      algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
      // No auth_data field
    };

    vi.spyOn(mockClient, "doRequest").mockResolvedValue(mockBackupResponse);

    const result = await getKeyBackupVersion(mockClient);

    expect(result).toEqual({
      version: "2",
      algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
      authData: {},
    });
  });
});

describe("getBackupDecryptionKey", () => {
  let mockClient: MatrixClient;
  const mockRecoveryKey = new Uint8Array(32).fill(1);

  beforeEach(() => {
    mockClient = {
      doRequest: vi.fn(),
      getUserId: vi.fn().mockResolvedValue("@user:example.com"),
    } as unknown as MatrixClient;

    // Mock secret storage metadata
    vi.spyOn(secretStorage, "fetchSecretStorageMetadata").mockResolvedValue({
      algorithm: "m.secret_storage.v1.aes-hmac-sha2",
      keyId: "test-key-id",
      iv: "AAAAAAAAAAAAAAAAAAAAAA==",
      mac: "dGVzdC1tYWM=",
    });
  });

  it("should decrypt backup key successfully", async () => {
    const mockBackupKeyData = {
      encrypted: {
        "test-key-id": {
          iv: "AAAAAAAAAAAAAAAAAAAAAA==",
          ciphertext: "dGVzdC1jaXBoZXJ0ZXh0",
          mac: "dGVzdC1tYWM=",
        },
      },
    };

    vi.spyOn(mockClient, "doRequest").mockResolvedValue(mockBackupKeyData);

    // Mock successful decryption
    const mockDecryptedKey = new Uint8Array(32).fill(2);
    vi.spyOn(secretStorage, "decryptSecret").mockReturnValue(mockDecryptedKey);

    const result = await getBackupDecryptionKey(mockClient, mockRecoveryKey);

    expect(result).toEqual(mockDecryptedKey);
    expect(mockClient.doRequest).toHaveBeenCalledWith(
      "GET",
      "/_matrix/client/v3/user/%40user%3Aexample.com/account_data/m.megolm_backup.v1",
    );
    expect(secretStorage.decryptSecret).toHaveBeenCalledWith(
      {
        iv: "AAAAAAAAAAAAAAAAAAAAAA==",
        ciphertext: "dGVzdC1jaXBoZXJ0ZXh0",
        mac: "dGVzdC1tYWM=",
      },
      mockRecoveryKey,
      "m.megolm_backup.v1",
    );
  });

  it("should throw error when backup key not found in account data", async () => {
    const error = new Error("Not found") as Error & { statusCode?: number };
    error.statusCode = 404;
    vi.spyOn(mockClient, "doRequest").mockRejectedValue(error);

    await expect(getBackupDecryptionKey(mockClient, mockRecoveryKey)).rejects.toThrow(
      "Backup key not found in account data",
    );
  });

  it("should throw error when backup key not encrypted with recovery key", async () => {
    const mockBackupKeyData = {
      encrypted: {
        "different-key-id": {
          iv: "AAAAAAAAAAAAAAAAAAAAAA==",
          ciphertext: "dGVzdC1jaXBoZXJ0ZXh0",
          mac: "dGVzdC1tYWM=",
        },
      },
    };

    vi.spyOn(mockClient, "doRequest").mockResolvedValue(mockBackupKeyData);

    await expect(getBackupDecryptionKey(mockClient, mockRecoveryKey)).rejects.toThrow(
      "Backup key not encrypted with recovery key",
    );
  });

  it("should throw error when decryption fails", async () => {
    const mockBackupKeyData = {
      encrypted: {
        "test-key-id": {
          iv: "AAAAAAAAAAAAAAAAAAAAAA==",
          ciphertext: "dGVzdC1jaXBoZXJ0ZXh0",
          mac: "dGVzdC1tYWM=",
        },
      },
    };

    vi.spyOn(mockClient, "doRequest").mockResolvedValue(mockBackupKeyData);
    vi.spyOn(secretStorage, "decryptSecret").mockImplementation(() => {
      throw new Error("MAC verification failed");
    });

    await expect(getBackupDecryptionKey(mockClient, mockRecoveryKey)).rejects.toThrow(
      "MAC verification failed",
    );
  });

  it("should throw error when decrypted key has invalid length", async () => {
    const mockBackupKeyData = {
      encrypted: {
        "test-key-id": {
          iv: "AAAAAAAAAAAAAAAAAAAAAA==",
          ciphertext: "dGVzdC1jaXBoZXJ0ZXh0",
          mac: "dGVzdC1tYWM=",
        },
      },
    };

    vi.spyOn(mockClient, "doRequest").mockResolvedValue(mockBackupKeyData);

    // Mock decryption returning wrong length
    const mockInvalidKey = new Uint8Array(16).fill(2); // Wrong length
    vi.spyOn(secretStorage, "decryptSecret").mockReturnValue(mockInvalidKey);

    await expect(getBackupDecryptionKey(mockClient, mockRecoveryKey)).rejects.toThrow(
      "Invalid backup key length: expected 32 bytes, got 16",
    );
  });
});

describe("restoreBackup", () => {
  let mockClient: MatrixClient;
  const mockBackupKey = new Uint8Array(32).fill(2);
  const mockBackupInfo: BackupInfo = {
    version: "2",
    algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
    authData: {
      public_key: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo",
    },
  };

  beforeEach(() => {
    mockClient = {
      doRequest: vi.fn(),
    } as unknown as MatrixClient;
  });

  it("should return 0 (not yet implemented due to bot-SDK limitations)", async () => {
    const result = await restoreBackup(mockClient, mockBackupKey, mockBackupInfo);
    expect(result).toBe(0);
  });
});
