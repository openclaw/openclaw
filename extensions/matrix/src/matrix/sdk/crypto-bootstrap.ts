import { setTimeout as sleep } from "node:timers/promises";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import type { MatrixDecryptBridge } from "./decrypt-bridge.js";
import { LogService } from "./logger.js";
import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import { isRepairableSecretStorageAccessError } from "./recovery-key-store.js";
import {
  MatrixCrossSigningResetRequiredError,
  MatrixUiaUnsupportedStagesError,
  type MatrixAuthDict,
  type MatrixCryptoBootstrapApi,
  type MatrixHomeserverCapabilities,
  type MatrixRawEvent,
  type MatrixUiAuthCallback,
  type MatrixUiaResponseBody,
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
  // Optional probe for homeserver capabilities. Used to detect MSC3861/MAS so
  // the bootstrap path can fail loud (vs. spinning on satisfiable-only-via-browser
  // UIA stages) and so reset attempts that will demonstrably 401 are skipped.
  getHomeserverCapabilities?: () => Promise<MatrixHomeserverCapabilities>;
};

function isUiaChallenge(
  err: unknown,
): err is { httpStatus: number; data: MatrixUiaResponseBody } {
  if (!err || typeof err !== "object") {
    return false;
  }
  const candidate = err as { httpStatus?: number; data?: { flows?: unknown } };
  return candidate.httpStatus === 401 && Array.isArray(candidate.data?.flows);
}

function extractUiaStages(body: MatrixUiaResponseBody): string[] {
  const flows = Array.isArray(body.flows) ? body.flows : [];
  const stages: string[] = [];
  for (const flow of flows) {
    if (!flow || !Array.isArray(flow.stages)) {
      continue;
    }
    for (const stage of flow.stages) {
      if (typeof stage === "string" && !stages.includes(stage)) {
        stages.push(stage);
      }
    }
  }
  return stages;
}

function extractMasResetUrl(body: MatrixUiaResponseBody): string | undefined {
  const params = body.params?.["org.matrix.cross_signing_reset"];
  const url = params && typeof params.url === "string" ? params.url : undefined;
  return url?.trim() || undefined;
}

function isCrossSigningKeyMismatchError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const message = (err as { message?: string }).message ?? "";
  // matrix-js-sdk wording: "Error while importing m.cross_signing.master:
  // The public key of the imported private key doesn't match the public key
  // that was uploaded to the server."
  return (
    message.includes("public key of the imported private key") &&
    message.includes("public key that was uploaded to the server")
  );
}

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

const CROSS_SIGNING_PUBLICATION_WAIT_MS = 5_000;

export class MatrixCryptoBootstrapper<TRawEvent extends MatrixRawEvent> {
  private verificationHandlerRegistered = false;
  private cachedCapabilities: Promise<MatrixHomeserverCapabilities> | null = null;

  constructor(private readonly deps: MatrixCryptoBootstrapperDeps<TRawEvent>) {}

  private async getHomeserverCapabilitiesCached(): Promise<MatrixHomeserverCapabilities> {
    const probe = this.deps.getHomeserverCapabilities;
    if (typeof probe !== "function") {
      return {};
    }
    if (!this.cachedCapabilities) {
      this.cachedCapabilities = probe().catch((err): MatrixHomeserverCapabilities => {
        LogService.warn(
          "MatrixClientLite",
          "Failed to probe homeserver capabilities; assuming non-MAS:",
          err,
        );
        return {};
      });
    }
    return await this.cachedCapabilities;
  }

  private async isMasFronted(): Promise<boolean> {
    const caps = await this.getHomeserverCapabilitiesCached();
    return caps.msAuthService === true;
  }

  // Per MSC2965 §6.4.4, clients construct action URLs as
  // `<account_management_uri>?action=<action>`. Used as a fallback when we
  // know we need to surface a reset URL but the synthetic error path didn't
  // see a UIA challenge body (e.g. when matrix-js-sdk's import-key-mismatch
  // throws before any upload attempt).
  private async masResetActionUrl(): Promise<string | undefined> {
    const caps = await this.getHomeserverCapabilitiesCached();
    const base = caps.accountManagementUri?.trim();
    if (!base) {
      return undefined;
    }
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}action=org.matrix.cross_signing_reset`;
  }

  async bootstrap(
    crypto: MatrixCryptoBootstrapApi,
    options: MatrixCryptoBootstrapOptions = {},
  ): Promise<MatrixCryptoBootstrapResult> {
    const strict = options.strict === true;
    const deferSecretStorageBootstrapUntilAfterCrossSigning =
      options.forceResetCrossSigning === true;
    // Register verification listeners before expensive bootstrap work so incoming requests
    // are not missed during startup.
    this.registerVerificationRequestHandler(crypto);
    if (!deferSecretStorageBootstrapUntilAfterCrossSigning) {
      await this.bootstrapSecretStorage(crypto, {
        strict,
        allowSecretStorageRecreateWithoutRecoveryKey:
          options.allowSecretStorageRecreateWithoutRecoveryKey === true,
      });
    }
    let crossSigning = await this.bootstrapCrossSigning(crypto, {
      forceResetCrossSigning: options.forceResetCrossSigning === true,
      allowAutomaticCrossSigningReset: options.allowAutomaticCrossSigningReset !== false,
      allowSecretStorageRecreateWithoutRecoveryKey:
        options.allowSecretStorageRecreateWithoutRecoveryKey === true,
      strict,
    });
    // Forced repair may need password UIA to upload new cross-signing keys. Delay any
    // secret-storage repair/recreation until after that step succeeds so passwordless bots do
    // not partially mutate SSSS on homeservers that require password-based UIA.
    await this.bootstrapSecretStorage(crypto, {
      strict,
      allowSecretStorageRecreateWithoutRecoveryKey:
        options.allowSecretStorageRecreateWithoutRecoveryKey === true,
    });
    if (deferSecretStorageBootstrapUntilAfterCrossSigning) {
      crossSigning = await this.bootstrapCrossSigning(crypto, {
        forceResetCrossSigning: false,
        allowAutomaticCrossSigningReset: false,
        allowSecretStorageRecreateWithoutRecoveryKey:
          options.allowSecretStorageRecreateWithoutRecoveryKey === true,
        strict,
      });
    }
    const ownDeviceVerified = await this.ensureOwnDeviceTrust(crypto, {
      strict,
    });
    return {
      crossSigningReady: crossSigning.ready,
      crossSigningPublished: crossSigning.published,
      ownDeviceVerified,
    };
  }

  private createSigningKeysUiAuthCallback(params: {
    userId: string;
    password?: string;
    isMasFronted: () => Promise<boolean>;
    masResetActionUrl: () => Promise<string | undefined>;
  }): MatrixUiAuthCallback {
    return async <T>(makeRequest: (authData: MatrixAuthDict | null) => Promise<T>): Promise<T> => {
      // First attempt is always no-auth: under MSC3967 the homeserver lets the
      // first /keys/device_signing/upload through without UIA when the user
      // has no master cross-signing key. Some homeservers also accept
      // re-uploads of identical keys without UIA.
      let firstError: unknown;
      try {
        return await makeRequest(null);
      } catch (err) {
        firstError = err;
      }

      if (!isUiaChallenge(firstError)) {
        throw firstError;
      }

      const body = firstError.data;
      const stages = extractUiaStages(body);
      const session = typeof body.session === "string" ? body.session : undefined;
      const password = params.password?.trim();

      if (stages.includes("m.login.dummy")) {
        return await makeRequest({ type: "m.login.dummy", session });
      }

      if (stages.includes("m.login.password") && password) {
        return await makeRequest({
          type: "m.login.password",
          identifier: { type: "m.id.user", user: params.userId },
          password,
          session,
        });
      }

      if (stages.includes("org.matrix.cross_signing_reset")) {
        throw new MatrixCrossSigningResetRequiredError({
          stages,
          resetUrl: extractMasResetUrl(body) ?? (await params.masResetActionUrl()),
          session,
        });
      }

      // No m.login.password configured but the homeserver only offers it: on
      // MAS-fronted servers this is the same dead-end as the reset stage, so
      // surface the more actionable error pointing operators at MAS recovery
      // (URL from the 401 body if present, else constructed via MSC2965 from
      // the cached account_management_uri).
      if (await params.isMasFronted()) {
        throw new MatrixCrossSigningResetRequiredError({
          stages,
          resetUrl: extractMasResetUrl(body) ?? (await params.masResetActionUrl()),
          session,
        });
      }

      throw new MatrixUiaUnsupportedStagesError({
        stages,
        hasPassword: Boolean(password),
      });
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
      isMasFronted: () => this.isMasFronted(),
      masResetActionUrl: () => this.masResetActionUrl(),
    });
    // We deliberately do not short-circuit before the upload attempt on
    // MAS-fronted servers, even when the user already has server-side
    // cross-signing keys. A reset upload looks doomed (Synapse returns 401
    // with the MAS reset stage), but when the operator has *just* approved
    // the cross-signing reset action in MAS, the next upload within the
    // approval window succeeds. The UIA callback turns the 401 into
    // MatrixCrossSigningResetRequiredError when approval has not happened,
    // and into a 200 when it has — letting the same code path serve both
    // the "what to do" and "do it" sides of the recovery flow.
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
    const refreshPublishedCrossSigningKeys = async (): Promise<void> => {
      if (typeof crypto.userHasCrossSigningKeys !== "function") {
        return;
      }
      try {
        await crypto.userHasCrossSigningKeys(userId, true);
      } catch {
        // The normal bootstrap flow below handles missing or unavailable keys.
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
      const published = ready
        ? await waitForPublishedCrossSigningKeys()
        : await hasPublishedCrossSigningKeys();
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

    const waitForPublishedCrossSigningKeys = async (): Promise<boolean> => {
      const startedAt = Date.now();
      do {
        if (await hasPublishedCrossSigningKeys()) {
          return true;
        }
        await sleep(250);
      } while (Date.now() - startedAt < CROSS_SIGNING_PUBLICATION_WAIT_MS);
      return false;
    };

    if (options.forceResetCrossSigning) {
      const resetCrossSigning = async (): Promise<void> => {
        await crypto.bootstrapCrossSigning({
          setupNewCrossSigning: true,
          authUploadDeviceSigningKeys,
        });
      };
      try {
        await resetCrossSigning();
        await this.trustFreshOwnIdentity(crypto);
      } catch (err) {
        // The MAS-specific reset error is fatal-with-actionable-message; never
        // mask it with a "failed; trying repair" warning.
        if (err instanceof MatrixCrossSigningResetRequiredError) {
          throw err;
        }
        const shouldRepairSecretStorage =
          options.allowSecretStorageRecreateWithoutRecoveryKey &&
          isRepairableSecretStorageAccessError(err);
        if (shouldRepairSecretStorage) {
          LogService.warn(
            "MatrixClientLite",
            "Forced cross-signing reset could not unlock secret storage; recreating secret storage and retrying.",
          );
          try {
            await this.deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
              allowSecretStorageRecreateWithoutRecoveryKey: true,
              forceNewSecretStorage: true,
            });
            await resetCrossSigning();
            await this.trustFreshOwnIdentity(crypto);
          } catch (repairErr) {
            if (repairErr instanceof MatrixCrossSigningResetRequiredError) {
              throw repairErr;
            }
            LogService.warn("MatrixClientLite", "Forced cross-signing reset failed:", repairErr);
            if (options.strict) {
              throw repairErr instanceof Error ? repairErr : new Error(String(repairErr));
            }
            return { ready: false, published: false };
          }
          return await finalize();
        }
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
      await refreshPublishedCrossSigningKeys();
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys,
      });
    } catch (err) {
      if (err instanceof MatrixCrossSigningResetRequiredError) {
        throw err;
      }
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
        try {
          await crypto.bootstrapCrossSigning({
            authUploadDeviceSigningKeys,
          });
        } catch (retryErr) {
          if (retryErr instanceof MatrixCrossSigningResetRequiredError) {
            throw retryErr;
          }
          throw retryErr;
        }
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
          if (resetErr instanceof MatrixCrossSigningResetRequiredError) {
            throw resetErr;
          }
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
    // On MAS-fronted homeservers without a recent cross-signing reset approval,
    // the upload below 401s and the UIA callback rethrows
    // MatrixCrossSigningResetRequiredError with the MAS reset URL. When the
    // approval window is open, the upload succeeds and a fresh identity lands.
    try {
      await crypto.bootstrapCrossSigning({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys,
      });
      await this.trustFreshOwnIdentity(crypto);
    } catch (err) {
      if (err instanceof MatrixCrossSigningResetRequiredError) {
        throw err;
      }
      LogService.warn("MatrixClientLite", "Fallback cross-signing bootstrap failed:", err);
      if (options.strict) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      return { ready: false, published: false };
    }

    return await finalize();
  }

  private async trustFreshOwnIdentity(crypto: MatrixCryptoBootstrapApi): Promise<void> {
    const ownIdentity =
      typeof crypto.getOwnIdentity === "function"
        ? await crypto.getOwnIdentity().catch(() => undefined)
        : undefined;
    if (!ownIdentity) {
      return;
    }

    try {
      if (typeof ownIdentity.isVerified === "function" && ownIdentity.isVerified()) {
        return;
      }
      await ownIdentity.verify?.();
    } finally {
      ownIdentity.free?.();
    }
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

    // Track incoming requests; verification lifecycle decisions live in the
    // verification manager so acceptance/start/dedupe share one code path.
    // Remote-user verifications are only auto-accepted. The human-operated
    // client must explicitly choose "Verify by emoji" so we do not race a
    // second SAS start from the bot side and end up with mismatched keys.
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
    });

    this.deps.decryptBridge.bindCryptoRetrySignals(crypto);
    LogService.info("MatrixClientLite", "Verification request handler registered");
  }

  private async ensureOwnDeviceTrust(
    crypto: MatrixCryptoBootstrapApi,
    options: {
      strict: boolean;
    },
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
    if (!verified && options.strict) {
      throw new Error(
        `Matrix own device ${deviceId} does not have full Matrix identity trust after bootstrap`,
      );
    }
    return verified;
  }
}
