//#region src/media/image-ops.d.ts
type ImageMetadata = {
  width: number;
  height: number;
};
type ResizeToJpegParams = {
  buffer: Buffer;
  maxSide: number;
  quality: number;
  withoutEnlargement?: boolean;
};
type ResizeToPngParams = {
  buffer: Buffer;
  maxSide: number;
  compressionLevel?: number;
  withoutEnlargement?: boolean;
};
declare const IMAGE_REDUCE_QUALITY_STEPS: readonly [85, 75, 65, 55, 45, 35];
declare const MAX_IMAGE_INPUT_PIXELS = 25000000;
declare class ImageProcessorUnavailableError extends Error {
  readonly code = "IMAGE_PROCESSOR_UNAVAILABLE";
  readonly operation: string;
  readonly causes: unknown[];
  constructor(operation: string, message?: string, causes?: unknown[]);
}
declare function isImageProcessorUnavailableError(err: unknown): boolean;
declare function buildImageResizeSideGrid(maxSide: number, sideStart: number): number[];
declare function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null>;
/**
 * Normalizes EXIF orientation in an image buffer.
 * Returns the buffer with correct pixel orientation (rotated if needed).
 * Falls back to original buffer if normalization fails.
 */
declare function normalizeExifOrientation(buffer: Buffer): Promise<Buffer>;
declare function resizeToJpeg(params: ResizeToJpegParams): Promise<Buffer>;
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
declare function resizeToPng(params: ResizeToPngParams): Promise<Buffer>;
declare function optimizeImageToPng(buffer: Buffer, maxBytes: number): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  compressionLevel: number;
}>;
//#endregion
export { buildImageResizeSideGrid as a, hasAlphaChannel as c, optimizeImageToPng as d, resizeToJpeg as f, MAX_IMAGE_INPUT_PIXELS as i, isImageProcessorUnavailableError as l, ImageMetadata as n, convertHeicToJpeg as o, resizeToPng as p, ImageProcessorUnavailableError as r, getImageMetadata as s, IMAGE_REDUCE_QUALITY_STEPS as t, normalizeExifOrientation as u };