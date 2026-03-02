import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { ACCOUNT_DATA_TYPES } from "./constants.js";
import { decryptSecret } from "./secret-storage.js";
import type { BackupInfo, EncryptedSecret } from "./types.js";

/**
 * Get the current key backup version from the homeserver.
 * Returns null if no backup exists (404).
 */
export async function getKeyBackupVersion(client: MatrixClient): Promise<BackupInfo | null> {
  try {
    // eslint-disable-next-line -- bot-sdk doRequest is the raw HTTP method
    const response = await (client as any).doRequest("GET", "/_matrix/client/v3/room_keys/version");
    if (!response?.version) {
      return null;
    }
    return response as BackupInfo;
  } catch (err: unknown) {
    // 404 means no backup
    if (err && typeof err === "object" && "statusCode" in err && (err as any).statusCode === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Decrypt the megolm backup decryption key from secret storage.
 * Returns null if no backup key is stored.
 */
export function getBackupDecryptionKey(
  accountData: Record<string, unknown>,
  recoveryKey: Uint8Array,
  keyId: string,
): Uint8Array | null {
  const backupData = accountData as { encrypted?: Record<string, EncryptedSecret> } | undefined;
  const encrypted = backupData?.encrypted?.[keyId];
  if (!encrypted) {
    return null;
  }

  // HKDF info must be the secret's own event type, not the storage key name
  const decryptedBytes = decryptSecret(encrypted, recoveryKey, ACCOUNT_DATA_TYPES.megolmBackup);

  // The decrypted value is base64-encoded
  return Buffer.from(Buffer.from(decryptedBytes).toString("utf-8"), "base64");
}

/**
 * Attempt to restore message keys from the server-side backup.
 *
 * Currently returns 0 because the bot-sdk doesn't expose session import APIs.
 * Device verification still works — messages sent by a verified device are trusted.
 */
export async function restoreBackup(
  client: MatrixClient,
  _backupKey: Uint8Array,
  backupInfo: BackupInfo,
  logger?: { warn: (msg: string) => void },
): Promise<number> {
  logger?.warn(
    `Key backup v${backupInfo.version} found but session import is not supported by the bot-sdk. ` +
      "Device verification is complete; historical messages may not decrypt until re-shared.",
  );
  return 0;
}

/**
 * Attempt backup restoration (non-blocking wrapper).
 * Fetches backup version, decrypts backup key if available, and attempts restore.
 */
export async function attemptBackupRestore(
  client: MatrixClient,
  recoveryKey: Uint8Array,
  keyId: string,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ version: string | null; keysRestored: number }> {
  try {
    const backupInfo = await getKeyBackupVersion(client);
    if (!backupInfo) {
      logger?.info("No key backup found on homeserver");
      return { version: null, keysRestored: 0 };
    }

    // eslint-disable-next-line -- bot-sdk account data accessor is untyped
    const backupAccountData = await (client as any).getAccountData(ACCOUNT_DATA_TYPES.megolmBackup);
    const backupKey = getBackupDecryptionKey(backupAccountData, recoveryKey, keyId);
    if (!backupKey) {
      logger?.warn("Backup key not found in secret storage — cannot restore backup");
      return { version: backupInfo.version, keysRestored: 0 };
    }

    const keysRestored = await restoreBackup(client, backupKey, backupInfo, logger);
    return { version: backupInfo.version, keysRestored };
  } catch (err) {
    logger?.warn(
      `Backup restore failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { version: null, keysRestored: 0 };
  }
}
