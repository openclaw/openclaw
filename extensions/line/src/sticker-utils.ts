export type LineStickerRef = {
  packageId: string;
  stickerId: string;
};

/**
 * Parse a raw sticker string into a LINE-specific packageId:stickerId ref.
 * Expected format: "<packageId>:<stickerId>" where both parts are numeric.
 * Returns undefined if the format is invalid.
 */
export function parseLineStickerRaw(raw: string): LineStickerRef | undefined {
  const parts = raw.split(":");
  if (parts.length !== 2) {
    return undefined;
  }
  const [packageId, stickerId] = parts;
  if (!packageId || !stickerId) {
    return undefined;
  }
  if (!/^\d+$/.test(packageId) || !/^\d+$/.test(stickerId)) {
    return undefined;
  }
  return { packageId, stickerId };
}
