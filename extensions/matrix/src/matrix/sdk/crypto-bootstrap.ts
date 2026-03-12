import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import { VerificationPhase } from "matrix-js-sdk/lib/crypto-api/verification.js";
import type { MatrixDecryptBridge } from "./decrypt-bridge.js";
import { LogService } from "./logger.js";
import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import { isRepairableSecretStorageAccessError } from "./recovery-key-store.js";
import type {
  MatrixAuthDict,
  MatrixCryptoBootstrapApi,
  MatrixRawEvent,
  MatrixUiAuthCallback,
} from "./types.js";
import type {
  MatrixVerificationManager,
  MatrixVerificationRequestLike,
} from "./verification-manager.js";
import { isMatrixDeviceOwnerVerified } from "./verification-status.js";

export type MatrixCryptoBootstrapperDeps<TRawEvent extends MatrixRawEvent> = {
  getUserId: () => Promise<string>;
  getPassword?: () => string | undefined;
  getDeviceId: () => string | null | undefined;
  verificationManager: MatrixVerificationManager;
  recoveryKeyStore: MatrixRecoveryKeyStore;
  decryptBridge: Pick<MatrixDecryptBridge<TRawEvent>, "bindCryptoRetrySignals">;
};

export type MatrixCryptoBootstrapOptions = {
  forceResetCrossSigning?: boolean;
  allowAutomaticCrossSigningReset?: boolean;
  allowSecretStorageRecreateWithoutRecoveryKey?: boolean;
  strict?: boolean;
};

export type MatrixCryptoBootstrapResult = {
  crossSigningReady: boolean;
  crossSigningPublished: boolean;
  ownDeviceVerified: boolean | null;
};

export class MatrixCryptoBootstrapper<TRawEvent extends MatrixRawEvent> {
  private verificationHandlerRegistered = false;

  constructor(private readonly deps: MatrixCryptoBootstrapperDeps<TRawEvent>) {}

  async bootstrap(
    crypto: MatrixCryptoBootstrapApi,
    options: MatrixCryptoBootstrapOptions = {},
  ): Promise<MatrixCryptoBootstrapResult> {
    const strict = options.strict === true;
    // Register verification listeners before expensive bootstrap work so incoming requests
    // are not missed during startup.
    this.registerVerificationRequestHandler(crypto);
    await this.bootstrapSecretStorage(crypto, {
      strict,
      allowSecretStorageRecreateWithoutRecoveryKey:
        options.allowSecretStorageRecreateWithoutRecoveryKey === true,
    });
    const crossSigning = await this.bootstrapCrossSigning(crypto, {
      forceResetCrossSigning: options.forceResetCrossSigning === true,
      allowAutomaticCrossSigningReset: options.allowAutomaticCrossSigningReset !== false,
      allowSecretStorageRecreateWithoutRecoveryKey:
        options.allowSecretStorageRecreateWithoutRecoveryKey === true,
      strict,
    });
    await this.bootstrapSecretStorage(crypto, {
      strict,
      allowSecretStorageRecreateWithoutRecoveryKey:
        options.allowSecretStorageRecreateWithoutRecoveryKey === true,
    });
    const ownDeviceVerified = await this.ensureOwnDeviceTrust(crypto, strict);
    return {
      crossSigningReady: crossSigning.ready,
      crossSigningPublished: crossSigning.published,
      ownDeviceVerified,
    };
  }

  private createSigningKeysUiAuthCallback(params: {
    userId: string;
    password?: string;
  }): MatrixUiAuthCallback {
    return async <T>(makeRequest: (authData: MatrixAuthDict | null) => Promise<T>): Promise<T> => {
      try {
        return await makeRequest(null);
      } catch {
        // Some homeservers require an explicit dummy UIA stage even when no user interaction is needed.
        try {
          return await makeRequest({ type: "m.login.dummy" });
        } catch {
          if (!params.password?.trim()) {
            throw new Error(
              "Matrix cross-signing key upload requires UIA; provide matrix.password for m.login.password fallback",
            );
          }
          return await makeRequest({
            type: "m.login.password",
            identifier: { type: "m.id.user", user: params.userId },
            password: params.password,
          });
        }
      }
    };
  }

  private async bootstrapCrossSigning(
    crypto: MatrixCryptoBootstrapApi,
    options: {
      forceResetCrossSigning: boolean;
      allowAutomaticCrossSigningReset: boolean;
      allowSecretStorageRecreateWithoutRecoveryKey: boolean;
      strict: boolean;
    },
  ): Promise<{ ready: boolean; published: boolean }> {
    const userId = await this.deps.getUserId();
    const authUploadDeviceSigningKeys = this.createSigningKeysUiAuthCallback({
      userId,
      password: this.deps.getPassword?.(),
    });
    const hasPublishedCrossSigningKeys = async (): Promise<boolean> => {
      if (typeof crypto.userHasCrossSigningKeys !== "function") {
        return true;
      }
      try {
        return await crypto.userHasCrossSigningKeys(userId, true);
      } catch {
        return false;
      }
    };
    const isCrossSigningReady = async (): Promise<boolean> => {
      if (typeof crypto.isCrossSigningReady !== "function") {
        return true;
      }
      try {
        return await crypto.isCrossSigningReady();
      } catch {
        return false;
      }
    };

    const finalize = async (): Promise<{ ready: boolean; published: boolean }> => {
      const ready = await isCrossSigningReady();
      const published = await hasPublishedCrossSigningKeys();
      if (ready && published) {
        LogService.info("MatrixClientLite", "Cross-signing bootstrap complete");
        return { ready, published };
      }
      const message = "Cross-signing bootstrap finished but server keys are still not published";
      LogService.warn("MatrixClientLite", message);
      if (options.strict) {
        throw new Error(message);
      }
      return { ready, published };
    };

    if (options.forceResetCrossSigning) {
      try {
        await crypto.bootstrapCrossSigning({
          setupNewCrossSigning: true,
          authUploadDeviceSigningKeys,
        });
      } catch (err) {
        LogService.warn("MatrixClientLite", "Forced cross-signing reset failed:", err);
        if (options.strict) {
          throw err instanceof Error ? err : new Error(String(err));
        }
        return { ready: false, published: false };
      }
      return await finalize();
    }

    // First pass: preserve existing cross-signing identity and ensure public keys are uploaded.
    try {
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys,
      });
    } catch (err) {
      const shouldRepairSecretStorage =
        options.allowSecretStorageRecreateWithoutRecoveryKey &&
        isRepairableSecretStorageAccessError(err);
      if (shouldRepairSecretStorage) {
        LogService.warn(
          "MatrixClientLite",
          "Cross-signing bootstrap could not unlock secret storage; recreating secret storage during explicit bootstrap and retrying.",
        );
        await this.deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
          allowSecretStorageRecreateWithoutRecoveryKey: true,
          forceNewSecretStorage: true,
        });
        await crypto.bootstrapCrossSigning({
          authUploadDeviceSigningKeys,
        });
      } else if (!options.allowAutomaticCrossSigningReset) {
        LogService.warn(
          "MatrixClientLite",
          "Initial cross-signing bootstrap failed and automatic reset is disabled:",
          err,
        );
        return { ready: false, published: false };
      } else {
        LogService.warn(
          "MatrixClientLite",
          "Initial cross-signing bootstrap failed, trying reset:",
          err,
        );
        try {
          await crypto.bootstrapCrossSigning({
            setupNewCrossSigning: true,
            authUploadDeviceSigningKeys,
          });
        } catch (resetErr) {
          LogService.warn("MatrixClientLite", "Failed to bootstrap cross-signing:", resetErr);
          if (options.strict) {
            throw resetErr instanceof Error ? resetErr : new Error(String(resetErr));
          }
          return { ready: false, published: false };
        }
      }
    }

    const firstPassReady = await isCrossSigningReady();
    const firstPassPublished = await hasPublishedCrossSigningKeys();
    if (firstPassReady && firstPassPublished) {
      LogService.info("MatrixClientLite", "Cross-signing bootstrap complete");
      return { ready: true, published: true };
    }

    if (!options.allowAutomaticCrossSigningReset) {
      return { ready: firstPassReady, published: firstPassPublished };
    }

    // Fallback: recover from broken local/server state by creating a fresh identity.
    try {
      await crypto.bootstrapCrossSigning({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys,
      });
    } catch (err) {
      LogService.warn("MatrixClientLite", "Fallback cross-signing bootstrap failed:", err);
      if (options.strict) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      return { ready: false, published: false };
    }

    return await finalize();
  }

  private async bootstrapSecretStorage(
    crypto: MatrixCryptoBootstrapApi,
    options: {
      strict: boolean;
      allowSecretStorageRecreateWithoutRecoveryKey: boolean;
    },
  ): Promise<void> {
    try {
      await this.deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
        allowSecretStorageRecreateWithoutRecoveryKey:
          options.allowSecretStorageRecreateWithoutRecoveryKey,
      });
      LogService.info("MatrixClientLite", "Secret storage bootstrap complete");
    } catch (err) {
      LogService.warn("MatrixClientLite", "Failed to bootstrap secret storage:", err);
      if (options.strict) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  private registerVerificationRequestHandler(crypto: MatrixCryptoBootstrapApi): void {
    if (this.verificationHandlerRegistered) {
      return;
    }
    this.verificationHandlerRegistered = true;

    // Auto-accept incoming verification requests from other users/devices.
    crypto.on(CryptoEvent.VerificationRequestReceived, async (request) => {
      const verificationRequest = request as MatrixVerificationRequestLike;
      try {
        this.deps.verificationManager.trackVerificationRequest(verificationRequest);
      } catch (err) {
        LogService.warn(
          "MatrixClientLite",
          `Failed to track verification request from ${verificationRequest.otherUserId}:`,
          err,
        );
      }
      const otherUserId = verificationRequest.otherUserId;
      const isSelfVerification = verificationRequest.isSelfVerification;
      const initiatedByMe = verificationRequest.initiatedByMe;
      const phase =
        typeof verificationRequest.phase === "number"
          ? verificationRequest.phase
          : VerificationPhase.Requested;
      const accepting = verificationRequest.accepting === true;
      const declining = verificationRequest.declining === true;

      if (isSelfVerification || initiatedByMe) {
        LogService.debug(
          "MatrixClientLite",
          `Ignoring ${isSelfVerification ? "self" : "initiated"} verification request from ${otherUserId}`,
        );
        return;
      }
      if (phase !== VerificationPhase.Requested || accepting || declining) {
        LogService.debug(
          "MatrixClientLite",
          `Skipping auto-accept for ${otherUserId} in phase=${phase} accepting=${accepting} declining=${declining}`,
        );
        return;
      }

      try {
        LogService.info(
          "MatrixClientLite",
          `Auto-accepting verification request from ${otherUserId}`,
        );
        await verificationRequest.accept();
        LogService.info(
          "MatrixClientLite",
          `Verification request from ${otherUserId} accepted, waiting for SAS...`,
        );
      } catch (err) {
        LogService.warn(
          "MatrixClientLite",
          `Failed to auto-accept verification from ${otherUserId}:`,
          err,
        );
      }
    });

    this.deps.decryptBridge.bindCryptoRetrySignals(crypto);
    LogService.info("MatrixClientLite", "Verification request handler registered");
  }

  private async ensureOwnDeviceTrust(
    crypto: MatrixCryptoBootstrapApi,
    strict = false,
  ): Promise<boolean | null> {
    const deviceId = this.deps.getDeviceId()?.trim();
    if (!deviceId) {
      return null;
    }
    const userId = await this.deps.getUserId();

    const deviceStatus =
      typeof crypto.getDeviceVerificationStatus === "function"
        ? await crypto.getDeviceVerificationStatus(userId, deviceId).catch(() => null)
        : null;
    const alreadyVerified = isMatrixDeviceOwnerVerified(deviceStatus);

    if (alreadyVerified) {
      return true;
    }

    if (typeof crypto.setDeviceVerified === "function") {
      await crypto.setDeviceVerified(userId, deviceId, true);
    }

    if (typeof crypto.crossSignDevice === "function") {
      const crossSigningReady =
        typeof crypto.isCrossSigningReady === "function"
          ? await crypto.isCrossSigningReady()
          : true;
      if (crossSigningReady) {
        await crypto.crossSignDevice(deviceId);
      }
    }

    const refreshedStatus =
      typeof crypto.getDeviceVerificationStatus === "function"
        ? await crypto.getDeviceVerificationStatus(userId, deviceId).catch(() => null)
        : null;
    const verified = isMatrixDeviceOwnerVerified(refreshedStatus);
    if (!verified && strict) {
      throw new Error(`Matrix own device ${deviceId} is not verified by its owner after bootstrap`);
    }
    return verified;
  }
}
