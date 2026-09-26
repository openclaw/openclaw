import type { MatrixDeviceVerificationStatusLike } from "./types.js";

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
