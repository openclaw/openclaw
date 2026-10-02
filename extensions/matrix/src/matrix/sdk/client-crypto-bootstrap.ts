import { throwIfMatrixStartupAborted } from "../startup-abort.js";
import {
  MATRIX_AUTOMATIC_REPAIR_BOOTSTRAP_OPTIONS,
  MATRIX_INITIAL_CRYPTO_BOOTSTRAP_OPTIONS,
  type MatrixOwnDeviceVerificationStatus,
} from "./client-support.js";
import type { MatrixCryptoBootstrapper } from "./crypto-bootstrap.js";
import { LogService } from "./logger.js";
import type { MatrixCryptoBootstrapApi, MatrixRawEvent } from "./types.js";

export async function bootstrapMatrixClientCrypto(params: {
  crypto?: MatrixCryptoBootstrapApi;
  bootstrapper?: MatrixCryptoBootstrapper<MatrixRawEvent>;
  getOwnDeviceVerificationStatus: () => Promise<MatrixOwnDeviceVerificationStatus>;
  abortSignal?: AbortSignal;
}): Promise<boolean> {
  const { crypto, bootstrapper, abortSignal } = params;
  if (!crypto || !bootstrapper) {
    return false;
  }
  const initial = await bootstrapper.bootstrap(crypto, MATRIX_INITIAL_CRYPTO_BOOTSTRAP_OPTIONS);
  throwIfMatrixStartupAborted(abortSignal);
  if (!initial.crossSigningPublished || initial.ownDeviceVerified === false) {
    const status = await params.getOwnDeviceVerificationStatus();
    if (status.signedByOwner) {
      LogService.warn(
        "MatrixClientLite",
        "Cross-signing/bootstrap is incomplete for an already owner-signed device; skipping automatic reset and preserving the current identity. Restore the recovery key or run an explicit verification bootstrap if repair is needed.",
      );
    } else {
      // Forced reset validates the active SSSS recovery key before rotating local keys.
      // Missing or stale recovery material fails without mutating crypto state.
      try {
        const repaired = await bootstrapper.bootstrap(
          crypto,
          MATRIX_AUTOMATIC_REPAIR_BOOTSTRAP_OPTIONS,
        );
        throwIfMatrixStartupAborted(abortSignal);
        if (repaired.crossSigningPublished && repaired.ownDeviceVerified !== false) {
          LogService.info(
            "MatrixClientLite",
            "Cross-signing/bootstrap recovered after forced reset",
          );
        }
      } catch (err) {
        LogService.warn(
          "MatrixClientLite",
          "Failed to recover cross-signing/bootstrap with forced reset:",
          err,
        );
      }
    }
  }
  return true;
}
