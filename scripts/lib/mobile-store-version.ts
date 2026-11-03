import { parseReleaseVersion } from "./release-version.mjs";

export const MAX_MOBILE_STORE_REVISION = 9;

export function encodeMobileStoreVersion(gatewayVersion: string, revision: number): string {
  const parsed = parseReleaseVersion(gatewayVersion);
  if (!parsed || parsed.version !== gatewayVersion || parsed.baseVersion !== gatewayVersion) {
    throw new Error(`Invalid mobile gateway version '${gatewayVersion}'. Expected YYYY.M.PATCH.`);
  }
  if (!Number.isInteger(revision) || revision < 0 || revision > MAX_MOBILE_STORE_REVISION) {
    throw new Error(
      `Invalid mobile store revision '${revision}'. Expected an integer from 0 to ${MAX_MOBILE_STORE_REVISION}.`,
    );
  }

  // One unpadded revision digit preserves store ordering when the gateway patch increments.
  const encodedPatch = Number(`${parsed.patch}${revision}`);
  if (!Number.isSafeInteger(encodedPatch)) {
    throw new RangeError(`Encoded mobile store version is too large for '${gatewayVersion}'.`);
  }
  return `${parsed.year}.${parsed.month}.${encodedPatch}`;
}
