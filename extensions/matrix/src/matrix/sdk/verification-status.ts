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
    status?.isVerified() === true ||
    status?.localVerified === true ||
    isMatrixDeviceOwnerVerified(status)
  );
}

export async function trustMatrixOwnIdentity(crypto: MatrixCryptoBootstrapApi): Promise<void> {
  const ownIdentity = await crypto.getOwnIdentity().catch(() => undefined);
  if (!ownIdentity) {
    return;
  }
  try {
    if (ownIdentity.isVerified()) {
      return;
    }
    await ownIdentity.verify();
  } finally {
    ownIdentity.free();
  }
}
