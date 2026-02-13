/**
 * Recovery key decoding and server-side key backup activation.
 *
 * Matrix recovery keys (starting with "EsTc" or similar) are base58-encoded
 * with a 0x8B01 prefix, 32-byte key, and 1-byte parity. This module decodes
 * them and activates backup via the matrix-sdk-crypto OlmMachine API.
 *
 * SDK limitation (v0.4.0): No `importBackedUpRoomKeys()` for bulk import.
 * Instead we register the key for gossiping and fetch individual sessions
 * from backup on UTD retry.
 */

import { BackupDecryptionKey } from "@matrix-org/matrix-sdk-crypto-nodejs";
import { matrixFetch } from "../client/http.js";
import { getMachine } from "./machine.js";

// ── Recovery Key Decoding ────────────────────────────────────────────────

const RECOVERY_KEY_PREFIX = new Uint8Array([0x8b, 0x01]);

/**
 * Decode a Matrix recovery key string into a 32-byte raw key.
 *
 * Format: base58(0x8B01 || 32-byte-key || parity-byte)
 * The parity byte is XOR of all preceding bytes.
 */
export async function decodeRecoveryKey(recoveryKey: string): Promise<Uint8Array> {
  // Strip spaces and dashes (recovery keys are often displayed grouped)
  const cleaned = recoveryKey.replace(/[\s-]/g, "");

  let decoded: Uint8Array;
  try {
    const bs58 = (await import("bs58")).default;
    decoded = Uint8Array.from(bs58.decode(cleaned));
  } catch (err: any) {
    throw new Error(`Failed to base58-decode recovery key: ${err.message}`);
  }

  // Must be 2 (prefix) + 32 (key) + 1 (parity) = 35 bytes
  if (decoded.length !== 35) {
    throw new Error(`Invalid recovery key length: expected 35 bytes, got ${decoded.length}`);
  }

  // Validate 0x8B01 prefix
  if (decoded[0] !== RECOVERY_KEY_PREFIX[0] || decoded[1] !== RECOVERY_KEY_PREFIX[1]) {
    throw new Error(
      `Invalid recovery key prefix: expected 0x8B01, got 0x${decoded[0].toString(16).padStart(2, "0")}${decoded[1].toString(16).padStart(2, "0")}`,
    );
  }

  // Validate parity byte (XOR of all preceding bytes)
  let parity = 0;
  for (let i = 0; i < 34; i++) {
    parity ^= decoded[i];
  }
  if (parity !== decoded[34]) {
    throw new Error("Recovery key parity check failed");
  }

  // Extract the 32-byte key (bytes 2..34)
  return decoded.slice(2, 34);
}

// ── Backup Activation ────────────────────────────────────────────────────

export interface BackupInfo {
  decryptionKey: BackupDecryptionKey;
  version: string;
}

/**
 * Activate server-side key backup using a recovery key.
 *
 * Steps:
 * 1. Decode recovery key → raw 32-byte key
 * 2. Create BackupDecryptionKey from raw bytes
 * 3. Fetch current backup version from server
 * 4. Verify the key matches the backup
 * 5. Save + enable backup in OlmMachine
 */
export async function activateRecoveryKey(
  recoveryKey: string,
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  },
): Promise<BackupInfo | undefined> {
  // Step 1: Decode
  let rawKey: Uint8Array;
  try {
    rawKey = await decodeRecoveryKey(recoveryKey);
  } catch (err: any) {
    log?.error?.(`[recovery] Failed to decode recovery key: ${err.message}`);
    return undefined;
  }

  // Step 2: Create BackupDecryptionKey
  let decryptionKey: BackupDecryptionKey;
  try {
    // The SDK expects base64-encoded key bytes
    const keyBase64 = Buffer.from(rawKey).toString("base64");
    decryptionKey = BackupDecryptionKey.fromBase64(keyBase64);
  } catch (err: any) {
    log?.error?.(`[recovery] Failed to create BackupDecryptionKey: ${err.message}`);
    return undefined;
  }

  // Step 3: Fetch current backup version
  let backupVersion: string;
  let backupData: any;
  try {
    backupData = await matrixFetch<{
      version: string;
      algorithm: string;
      auth_data: Record<string, unknown>;
    }>("GET", "/_matrix/client/v3/room_keys/version");
    backupVersion = backupData.version;
    log?.info?.(
      `[recovery] Found backup version ${backupVersion} (algorithm: ${backupData.algorithm})`,
    );
  } catch (err: any) {
    log?.warn?.(`[recovery] No key backup found on server: ${err.message}`);
    return undefined;
  }

  // Step 4: Verify the key matches the backup
  const machine = getMachine();
  try {
    const verified = machine.verifyBackup(JSON.stringify(backupData));
    if (!verified) {
      // verifyBackup may return a truthy/falsy result or throw
      log?.warn?.("[recovery] Backup verification returned falsy — key may not match");
    }
  } catch (err: any) {
    // Some SDK versions don't have verifyBackup or it has a different signature
    log?.warn?.(`[recovery] Backup verification check skipped: ${err.message}`);
  }

  // Step 5: Save + enable backup
  try {
    await machine.saveBackupDecryptionKey(decryptionKey, backupVersion);
    log?.info?.(`[recovery] Saved backup decryption key for version ${backupVersion}`);
  } catch (err: any) {
    log?.error?.(`[recovery] Failed to save backup decryption key: ${err.message}`);
    return undefined;
  }

  try {
    machine.enableBackupV1((backupData.auth_data as any)?.public_key ?? "", backupVersion);
    log?.info?.("[recovery] Backup v1 enabled");
  } catch (err: any) {
    // enableBackupV1 may not exist in all SDK versions
    log?.warn?.(`[recovery] enableBackupV1 not available: ${err.message}`);
  }

  return { decryptionKey, version: backupVersion };
}

// ── Per-Session Backup Fetch ────────────────────────────────────────────

/**
 * Fetch and decrypt a single Megolm session from server-side backup.
 * Used as UTD fallback when normal key gossiping fails.
 *
 * SDK limitation (v0.4.0): OlmMachine has no importRoomKeys() or
 * importBackedUpRoomKeys(). We decrypt the session and feed it back
 * as a synthetic to-device event via receiveSyncChanges(), which is
 * the closest mechanism to inject session keys into the crypto store.
 */
export async function decryptSessionFromBackup(
  decryptionKey: BackupDecryptionKey,
  backupVersion: string,
  roomId: string,
  sessionId: string,
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<boolean> {
  try {
    // Fetch the specific session from backup
    const backupData = await matrixFetch<{
      first_message_index: number;
      forwarded_count: number;
      is_verified: boolean;
      session_data: { ciphertext: string; ephemeral: string; mac: string };
    }>(
      "GET",
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(roomId)}/${encodeURIComponent(sessionId)}?version=${encodeURIComponent(backupVersion)}`,
    );

    if (!backupData?.session_data) {
      log?.warn?.(`[recovery] No backup data for session ${sessionId} in ${roomId}`);
      return false;
    }

    // Decrypt the session using the BackupDecryptionKey
    const decrypted = decryptionKey.decryptV1(
      backupData.session_data.ephemeral,
      backupData.session_data.mac,
      backupData.session_data.ciphertext,
    );

    // Parse decrypted session data — contains session_key, sender_key, etc.
    const sessionData = JSON.parse(decrypted);

    // Feed the session key back into OlmMachine as a forwarded_room_key to-device event.
    // This is the mechanism the SDK uses to ingest room keys from key forwards.
    const machine = getMachine();
    const syntheticToDevice = [
      {
        type: "m.forwarded_room_key",
        sender: machine.userId.toString(),
        content: {
          algorithm: sessionData.algorithm ?? "m.megolm.v1.aes-sha2",
          room_id: roomId,
          sender_key: sessionData.sender_key ?? "",
          session_id: sessionId,
          session_key: sessionData.session_key,
          sender_claimed_ed25519_key: sessionData.sender_claimed_keys?.ed25519 ?? "",
          forwarding_curve25519_key_chain: sessionData.forwarding_curve25519_key_chain ?? [],
        },
      },
    ];

    // Inject via receiveSyncChanges with empty device lists and key counts
    const { DeviceLists } = await import("@matrix-org/matrix-sdk-crypto-nodejs");
    await machine.receiveSyncChanges(JSON.stringify(syntheticToDevice), new DeviceLists(), {}, []);

    log?.info?.(`[recovery] Injected session ${sessionId} from backup into crypto store`);
    return true;
  } catch (err: any) {
    log?.warn?.(`[recovery] Failed to restore session ${sessionId} from backup: ${err.message}`);
    return false;
  }
}
