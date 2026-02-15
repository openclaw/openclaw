/**
 * Matrix key backup operations for recovery key verification.
 */

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { BackupInfo, EncryptedSecret } from "./types.js";
import { ACCOUNT_DATA_TYPES } from "./constants.js";
import { decryptSecret } from "./secret-storage.js";
import { fetchSecretStorageMetadata } from "./secret-storage.js";

/**
 * Get current key backup version from homeserver.
 *
 * @param client - Matrix client instance
 * @returns Backup info if backup exists, null if no backup configured
 * @throws Error if API call fails (non-404 errors)
 */
export async function getKeyBackupVersion(client: MatrixClient): Promise<BackupInfo | null> {
  try {
    const response = (await client.doRequest("GET", "/_matrix/client/v3/room_keys/version")) as {
      version?: string;
      algorithm?: string;
      auth_data?: {
        public_key?: string;
        [key: string]: unknown;
      };
    };

    // Validate required fields
    if (!response.version || !response.algorithm) {
      throw new Error("Invalid backup response: missing version or algorithm");
    }

    return {
      version: response.version,
      algorithm: response.algorithm,
      authData: response.auth_data ?? {},
    };
  } catch (error) {
    // Check if it's a 404 (no backup exists)
    if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 404) {
      return null;
    }

    // Re-throw other errors (network issues, 500, etc.)
    throw error;
  }
}

/**
 * Get backup decryption key from account data.
 *
 * @param client - Matrix client instance
 * @param recoveryKey - 32-byte recovery key for decryption
 * @returns Decrypted 32-byte backup key
 * @throws Error if backup key is missing or decryption fails
 */
export async function getBackupDecryptionKey(
  client: MatrixClient,
  recoveryKey: Uint8Array,
): Promise<Uint8Array> {
  const userId = await client.getUserId();

  // Fetch encrypted backup key from account data
  const backupKeyUrl = `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${ACCOUNT_DATA_TYPES.MEGOLM_BACKUP_V1}`;

  let backupKeyData: {
    encrypted?: Record<string, { iv: string; ciphertext: string; mac: string }>;
    [key: string]: unknown;
  };

  try {
    backupKeyData = (await client.doRequest("GET", backupKeyUrl)) as typeof backupKeyData;
  } catch (error) {
    throw new Error("Backup key not found in account data", { cause: error });
  }

  // Get secret storage key ID to find the correct encrypted secret
  const metadata = await fetchSecretStorageMetadata(client);
  const keyId = metadata.keyId;

  // Extract encrypted backup key
  const encrypted = backupKeyData.encrypted?.[keyId];
  if (!encrypted) {
    throw new Error("Backup key not encrypted with recovery key");
  }

  // Decrypt using same algorithm as cross-signing keys
  const backupKey = decryptSecret(
    encrypted as EncryptedSecret,
    recoveryKey,
    ACCOUNT_DATA_TYPES.MEGOLM_BACKUP_V1,
  );

  // Validate key length (should be 32 bytes for AES-256)
  if (backupKey.length !== 32) {
    throw new Error(`Invalid backup key length: expected 32 bytes, got ${backupKey.length}`);
  }

  return backupKey;
}

/**
 * Restore key backup sessions into crypto store.
 *
 * @param client - Matrix client instance
 * @param backupKey - 32-byte backup decryption key
 * @param backupInfo - Backup version and algorithm info
 * @returns Number of sessions restored (0 if not supported)
 *
 * NOTE: Session import is currently not supported due to bot-SDK limitations.
 * The bot-SDK crypto store does not expose APIs for importing Megolm sessions.
 * This function is a placeholder for future implementation when bot-SDK adds support.
 */
export async function restoreBackup(
  _client: MatrixClient,
  _backupKey: Uint8Array,
  _backupInfo: BackupInfo,
): Promise<number> {
  // TODO: Verify backup signatures before restore (MSC1219)
  // TODO: Implement when bot-SDK exposes session import APIs
  // For now, return 0 to indicate no sessions restored
  // The handler will log a warning about this limitation

  // The implementation would look like:
  // 1. Download encrypted sessions from GET /_matrix/client/v3/room_keys/keys?version={version}
  // 2. Decrypt each session using backupKey (algorithm: m.megolm_backup.v1.curve25519-aes-sha2)
  // 3. Import sessions into crypto store via client.crypto APIs (not currently exposed)
  // 4. Return count of successfully restored sessions

  return 0;
}
