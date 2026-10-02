import type { MatrixCryptoBootstrapApi, MatrixDeviceVerificationStatusLike } from "./types.js";

export function isMatrixDeviceOwnerVerified(
  status: MatrixDeviceVerificationStatusLike | null | undefined,
): boolean {
  return status?.crossSigningVerified === true;
}

export function isMatrixDeviceVerifiedInCurrentClient(
  status: MatrixDeviceVerificationStatusLike | null | undefined,
): boolean {
  return (
    status?.isVerified?.() === true ||
    status?.localVerified === true ||
    isMatrixDeviceOwnerVerified(status)
  );
}

export async function trustMatrixOwnIdentity(crypto: MatrixCryptoBootstrapApi): Promise<void> {
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
    if (typeof ownIdentity.verify === "function") {
      await ownIdentity.verify();
    }
  } finally {
    ownIdentity.free?.();
  }
}
