/**
 * Recovery key handler for Matrix device verification.
 */

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { RuntimeLogger } from "openclaw/plugin-sdk";
import crypto from "node:crypto";
import type { VerificationStore } from "./store.js";
import type { VerificationResult } from "./types.js";
import { getKeyBackupVersion, getBackupDecryptionKey, restoreBackup } from "./backup.js";
import { ERROR_MESSAGES } from "./constants.js";
import { decodeRecoveryKey } from "./crypto-utils.js";
import { getCurrentDeviceKeys, signDevice, uploadDeviceSignature } from "./device-signing.js";
import { fetchCrossSigningKeys } from "./secret-storage.js";

/**
 * Handler for recovery key-based device verification.
 */
export class RecoveryKeyHandler {
  constructor(
    private readonly client: MatrixClient,
    private readonly store: VerificationStore,
    private readonly logger?: RuntimeLogger,
  ) {}

  /**
   * Get the verification store instance.
   */
  getStore(): VerificationStore {
    return this.store;
  }

  /**
   * Verify device using recovery key.
   *
   * @param key - Recovery key (58-character Base58-encoded string)
   * @returns Verification result
   *
   * @example
   * const result = await handler.verifyWithRecoveryKey("EsTc 5rr1 4Jhp...");
   * if (result.success) {
   *   console.log("Device verified!");
   * }
   */
  async verifyWithRecoveryKey(key: string): Promise<VerificationResult> {
    try {
      // Step 1: Decode and validate recovery key format
      this.logger?.debug?.("matrix: decoding recovery key");
      const recoveryKey = decodeRecoveryKey(key);

      // Step 2: Compute key hash for replay protection
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bot-SDK does not expose deviceId in CryptoClient types
      const deviceId = (this.client.crypto as any)?.deviceId as string | undefined;
      if (!deviceId) {
        throw new Error("Device ID not available");
      }

      const keyHash = crypto
        .createHmac("sha256", Buffer.concat([Buffer.from(recoveryKey), Buffer.from(deviceId)]))
        .digest("hex");

      // Step 3: Check replay protection
      this.logger?.debug?.("matrix: checking replay protection");
      if (this.store.isRecoveryKeyUsed(keyHash)) {
        throw new Error(ERROR_MESSAGES.RECOVERY_KEY_ALREADY_USED);
      }

      // Step 4: Decrypt cross-signing keys (fetches secret storage metadata internally)
      this.logger?.debug?.("matrix: decrypting cross-signing keys");
      const crossSigningKeys = await fetchCrossSigningKeys(this.client, recoveryKey);

      // Step 6: Get current device keys
      this.logger?.debug?.("matrix: retrieving current device keys");
      const deviceKeys = await getCurrentDeviceKeys(this.client);

      // Step 7: Sign device with self-signing key
      this.logger?.debug?.("matrix: signing device");
      const signature = signDevice(deviceKeys, crossSigningKeys.selfSigning.privateKey);

      // Step 8: Get self-signing key ID (Base64-encoded public key)
      const selfSigningKeyId = crossSigningKeys.selfSigning.publicKey;

      // Step 9: Upload signature to homeserver
      this.logger?.debug?.("matrix: uploading device signature");
      await uploadDeviceSignature(
        this.client,
        deviceKeys.userId,
        deviceKeys.deviceId,
        deviceKeys,
        signature,
        selfSigningKeyId,
      );

      // Step 10: Mark recovery key as used (replay protection)
      this.logger?.debug?.("matrix: marking recovery key as used");
      await this.store.markRecoveryKeyUsed(keyHash);

      // Step 11: Update store with verified status
      this.logger?.debug?.("matrix: persisting device verification state");
      await this.store.setDeviceVerified(true, deviceKeys.deviceId);

      // Step 12: Attempt backup restoration (non-blocking)
      let backupRestored = false;
      let restoredSessionCount = 0;
      let backupVersion: string | undefined;

      try {
        this.logger?.debug?.("matrix: checking for key backup");
        const backupInfo = await getKeyBackupVersion(this.client);

        if (backupInfo) {
          this.logger?.info?.(
            `matrix: key backup found (version ${backupInfo.version}), attempting restoration`,
          );

          try {
            // Get backup decryption key
            this.logger?.debug?.("matrix: decrypting backup key");
            const backupKey = await getBackupDecryptionKey(this.client, recoveryKey);

            // Restore backup sessions
            this.logger?.debug?.("matrix: restoring backup sessions");
            restoredSessionCount = await restoreBackup(this.client, backupKey, backupInfo);

            // Zero out backup key
            backupKey.fill(0);

            if (restoredSessionCount > 0) {
              backupRestored = true;
              backupVersion = backupInfo.version;

              // Update store with backup info
              await this.store.setKeyBackupInfo(backupInfo.version, restoredSessionCount);

              this.logger?.info?.(
                `matrix: restored ${restoredSessionCount} session keys from backup`,
              );
            } else {
              // Bot-SDK limitation: session import not supported
              this.logger?.warn?.(
                "matrix: backup restoration not supported - bot-SDK crypto store does not expose session import APIs",
              );
              this.logger?.info?.(
                "matrix: device verified successfully, but message history may not be available",
              );
            }
          } catch (backupError) {
            // Log backup restoration error but don't fail verification
            this.logger?.warn?.("matrix: backup restoration failed (device still verified)", {
              error: backupError instanceof Error ? backupError.message : String(backupError),
            });
          }
        } else {
          this.logger?.info?.("matrix: no key backup configured on this account");
        }
      } catch (backupCheckError) {
        // Log error checking for backup but don't fail verification
        this.logger?.warn?.("matrix: failed to check for key backup (device still verified)", {
          error:
            backupCheckError instanceof Error ? backupCheckError.message : String(backupCheckError),
        });
      }

      // Step 13: Zero out sensitive key material
      recoveryKey.fill(0);
      crossSigningKeys.master.privateKey.fill(0);
      crossSigningKeys.selfSigning.privateKey.fill(0);
      crossSigningKeys.userSigning.privateKey.fill(0);

      this.logger?.info?.("matrix: device verification completed successfully");

      return {
        success: true,
        deviceId: deviceKeys.deviceId,
        backupRestored,
        restoredSessionCount,
        backupVersion,
      };
    } catch (error) {
      this.logger?.error?.("matrix: device verification failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      // Return user-friendly error
      if (error instanceof Error) {
        return {
          success: false,
          error: error.message,
          backupRestored: false,
          restoredSessionCount: 0,
        };
      }

      return {
        success: false,
        error: "Unknown error occurred during verification",
        backupRestored: false,
        restoredSessionCount: 0,
      };
    }
  }
}
