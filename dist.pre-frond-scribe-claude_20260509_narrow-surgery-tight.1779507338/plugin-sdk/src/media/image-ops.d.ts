export type ImageMetadata = {
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
export declare const IMAGE_REDUCE_QUALITY_STEPS: readonly [85, 75, 65, 55, 45, 35];
export declare const MAX_IMAGE_INPUT_PIXELS = 25000000;
export declare class ImageProcessorUnavailableError extends Error {
    readonly code = "IMAGE_PROCESSOR_UNAVAILABLE";
    readonly operation: string;
    readonly causes: unknown[];
    constructor(operation: string, message?: string, causes?: unknown[]);
}
export declare function isImageProcessorUnavailableError(err: unknown): boolean;
export declare function buildImageResizeSideGrid(maxSide: number, sideStart: number): number[];
export declare function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null>;
/**
 * Normalizes EXIF orientation in an image buffer.
 * Returns the buffer with correct pixel orientation (rotated if needed).
 * Falls back to original buffer if normalization fails.
 */
export declare function normalizeExifOrientation(buffer: Buffer): Promise<Buffer>;
export declare function resizeToJpeg(params: ResizeToJpegParams): Promise<Buffer>;
export declare function convertHeicToJpeg(buffer: Buffer): Promise<Buffer>;
/**
 * Checks if an image has an alpha channel (transparency).
 * Returns true if the image has alpha, false otherwise.
 */
export declare function hasAlphaChannel(buffer: Buffer): Promise<boolean>;
/**
 * Resizes an image to PNG format, preserving alpha channel (transparency).
 * Falls back to the media attachments plugin only (no sips fallback for PNG with alpha).
 */
export declare function resizeToPng(params: ResizeToPngParams): Promise<Buffer>;
export declare function optimizeImageToPng(buffer: Buffer, maxBytes: number): Promise<{
    buffer: Buffer;
    optimizedSize: number;
    resizeSide: number;
    compressionLevel: number;
}>;
export {};
