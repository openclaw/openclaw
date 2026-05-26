import { a as MediaKind } from "./constants-Bjv4FoLj.js";

//#region src/media/mime.d.ts
/** @internal */
declare const FILE_TYPE_SNIFF_MAX_BYTES: number;
declare function normalizeMimeType(mime?: string | null): string | undefined;
/** @internal */
declare function sliceMimeSniffBuffer(buffer: Buffer): Buffer;
declare function getFileExtension(filePath?: string | null): string | undefined;
declare function mimeTypeFromFilePath(filePath?: string | null): string | undefined;
declare function isAudioFileName(fileName?: string | null): boolean;
declare function detectMime(opts: {
  buffer?: Buffer;
  headerMime?: string | null;
  filePath?: string;
}): Promise<string | undefined>;
declare function extensionForMime(mime?: string | null): string | undefined;
declare function isGifMedia(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean;
declare function imageMimeFromFormat(format?: string | null): string | undefined;
declare function kindFromMime(mime?: string | null): MediaKind | undefined;
//#endregion
export { imageMimeFromFormat as a, kindFromMime as c, sliceMimeSniffBuffer as d, getFileExtension as i, mimeTypeFromFilePath as l, detectMime as n, isAudioFileName as o, extensionForMime as r, isGifMedia as s, FILE_TYPE_SNIFF_MAX_BYTES as t, normalizeMimeType as u };