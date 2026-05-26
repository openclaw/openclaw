import { n as ImageMetadata } from "../../image-ops-xNaOYvkf.js";

//#region extensions/media-understanding-core/image-ops.d.ts
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
type MediaUnderstandingImageOpsOptions = {
  maxInputPixels: number;
};
declare function createMediaAttachmentImageOps(options: MediaUnderstandingImageOpsOptions): {
  getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null>;
  normalizeExifOrientation(buffer: Buffer): Promise<Buffer>;
  resizeToJpeg(params: ResizeToJpegParams): Promise<Buffer>;
  convertHeicToJpeg(buffer: Buffer): Promise<Buffer>;
  hasAlphaChannel(buffer: Buffer): Promise<boolean>;
  resizeToPng(params: ResizeToPngParams): Promise<Buffer>;
};
//#endregion
export { createMediaAttachmentImageOps };