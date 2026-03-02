import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { attemptBackupRestore } from "./backup.js";
import { ERROR_MESSAGES } from "./constants.js";
import { decodeRecoveryKey } from "./crypto-utils.js";
import { getCurrentDeviceKeys, signDevice, uploadDeviceSignature } from "./device-signing.js";
import { fetchCrossSigningKeys, fetchSecretStorageMetadata } from "./secret-storage.js";
import type { RecoveryKeyStore } from "./store.js";
import type { VerificationResult } from "./types.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

/**
 * Zero out a Uint8Array in place to scrub sensitive key material.
 */
function zeroOut(buf: Uint8Array): void {
  buf.fill(0);
}

/**
 * Main recovery key handler.
 *
 * Flow: decode key -> check replay -> decrypt cross-signing keys ->
 * get device keys -> sign device -> upload signature -> mark used ->
 * persist verified state -> attempt backup restore (non-blocking) ->
 * zero out all key material in finally.
 */
export class RecoveryKeyHandler {
  private readonly client: MatrixClient;
  private readonly store: RecoveryKeyStore;
  private readonly logger: Logger;

  constructor(client: MatrixClient, store: RecoveryKeyStore, logger: Logger) {
    this.client = client;
    this.store = store;
    this.logger = logger;
  }

  async verifyWithRecoveryKey(rawKey: string): Promise<VerificationResult> {
    let recoveryKey: Uint8Array | null = null;
    let masterKey: Uint8Array | null = null;
    let selfSigningKey: Uint8Array | null = null;
    let userSigningKey: Uint8Array | null = null;

    try {
      // Step 1: Decode the recovery key
      try {
        recoveryKey = decodeRecoveryKey(rawKey);
      } catch {
        return { success: false, error: ERROR_MESSAGES.invalidKey };
      }

      // Step 2: Get device keys (also validates crypto is available)
      let deviceKeys;
      try {
        deviceKeys = getCurrentDeviceKeys(this.client);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `${ERROR_MESSAGES.noCryptoClient}: ${msg}` };
      }

      // Step 3: Check replay protection
      const keyHash = this.store.computeKeyHash(recoveryKey, deviceKeys.deviceId);
      if (this.store.isReplayDetected(keyHash)) {
        return { success: false, error: ERROR_MESSAGES.replayDetected };
      }

      // Step 4: Fetch secret storage metadata
      let keyId: string;
      try {
        const metadata = await fetchSecretStorageMetadata(this.client);
        keyId = metadata.keyId;
      } catch (err) {
        return {
          success: false,
          error: `${ERROR_MESSAGES.noDefaultKey}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Step 5: Decrypt cross-signing keys
      let crossSigningKeys;
      try {
        crossSigningKeys = await fetchCrossSigningKeys(this.client, recoveryKey, keyId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("MAC")) {
          return { success: false, error: ERROR_MESSAGES.macMismatch };
        }
        return {
          success: false,
          error: `${ERROR_MESSAGES.noSelfSigningKey}: ${msg}`,
        };
      }

      masterKey = crossSigningKeys.masterKey;
      selfSigningKey = crossSigningKeys.selfSigningKey;
      userSigningKey = crossSigningKeys.userSigningKey;

      // Step 6: Sign the device with the self-signing key
      const { signature, keyId: signingKeyId } = signDevice(
        deviceKeys,
        selfSigningKey,
        crossSigningKeys.selfSigningKeyPublic,
      );

      // Step 7: Upload signature to homeserver
      try {
        await uploadDeviceSignature(this.client, {
          userId: deviceKeys.userId,
          deviceId: deviceKeys.deviceId,
          ed25519Key: deviceKeys.ed25519Key,
          curve25519Key: deviceKeys.curve25519Key,
          signature,
          signingKeyId,
        });
      } catch (err) {
        return {
          success: false,
          error: `${ERROR_MESSAGES.signatureFailed}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Step 8: Mark key as used (replay protection)
      this.store.markKeyUsed(keyHash);

      // Step 9: Attempt backup restore (non-blocking)
      const backup = await attemptBackupRestore(this.client, recoveryKey, keyId, this.logger);

      // Step 10: Persist verified state
      await this.store.markVerified(deviceKeys.deviceId, backup.version);

      this.logger.info(
        `matrix: device verification completed successfully (device: ${deviceKeys.deviceId})`,
      );

      return {
        success: true,
        deviceId: deviceKeys.deviceId,
        verifiedAt: new Date().toISOString(),
        backupVersion: backup.version,
        backupKeysRestored: backup.keysRestored,
      };
    } catch (err) {
      this.logger.error(
        `matrix: recovery key verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // Zero out all sensitive key material
      if (recoveryKey) zeroOut(recoveryKey);
      if (masterKey) zeroOut(masterKey);
      if (selfSigningKey) zeroOut(selfSigningKey);
      if (userSigningKey) zeroOut(userSigningKey);
    }
  }
}
