//#region src/media/image-ops.d.ts
type ImageMetadata = {
  width: number;
  height: number;
};
declare const IMAGE_REDUCE_QUALITY_STEPS: readonly [85, 75, 65, 55, 45, 35];
declare const MAX_IMAGE_INPUT_PIXELS = 25000000;
declare function buildImageResizeSideGrid(maxSide: number, sideStart: number): number[];
declare function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null>;
/**
 * Normalizes EXIF orientation in an image buffer.
 * Returns the buffer with correct pixel orientation (rotated if needed).
 * Falls back to original buffer if normalization fails.
 */
declare function normalizeExifOrientation(buffer: Buffer): Promise<Buffer>;
declare function resizeToJpeg(params: {
  buffer: Buffer;
  maxSide: number;
  quality: number;
  withoutEnlargement?: boolean;
}): Promise<Buffer>;
declare function convertHeicToJpeg(buffer: Buffer): Promise<Buffer>;
/**
 * Checks if an image has an alpha channel (transparency).
 * Returns true if the image has alpha, false otherwise.
 */
declare function hasAlphaChannel(buffer: Buffer): Promise<boolean>;
/**
 * Resizes an image to PNG format, preserving alpha channel (transparency).
 * Falls back to the media attachments plugin only (no sips fallback for PNG with alpha).
 */
declare function resizeToPng(params: {
  buffer: Buffer;
  maxSide: number;
  compressionLevel?: number;
  withoutEnlargement?: boolean;
}): Promise<Buffer>;
declare function optimizeImageToPng(buffer: Buffer, maxBytes: number): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  compressionLevel: number;
}>;
//#endregion
//#region src/media/local-media-access.d.ts
type LocalMediaAccessErrorCode = "path-not-allowed" | "invalid-root" | "invalid-file-url" | "network-path-not-allowed" | "unsafe-bypass" | "not-found" | "invalid-path" | "not-file";
declare class LocalMediaAccessError extends Error {
  code: LocalMediaAccessErrorCode;
  constructor(code: LocalMediaAccessErrorCode, message: string, options?: ErrorOptions);
}
declare function getDefaultLocalRoots(): readonly string[];
declare function assertLocalMediaAllowed(mediaPath: string, localRoots: readonly string[] | "any" | undefined): Promise<void>;
//#endregion
export { IMAGE_REDUCE_QUALITY_STEPS as a, buildImageResizeSideGrid as c, hasAlphaChannel as d, normalizeExifOrientation as f, resizeToPng as h, getDefaultLocalRoots as i, convertHeicToJpeg as l, resizeToJpeg as m, LocalMediaAccessErrorCode as n, ImageMetadata as o, optimizeImageToPng as p, assertLocalMediaAllowed as r, MAX_IMAGE_INPUT_PIXELS as s, LocalMediaAccessError as t, getImageMetadata as u };