import { type MediaKind } from "./constants.js";
export declare function normalizeMimeType(mime?: string | null): string | undefined;
export declare function getFileExtension(filePath?: string | null): string | undefined;
export declare function isAudioFileName(fileName?: string | null): boolean;
export declare function detectMime(opts: {
    buffer?: Buffer;
    headerMime?: string | null;
    filePath?: string;
}): Promise<string | undefined>;
export declare function extensionForMime(mime?: string | null): string | undefined;
export declare function isGifMedia(opts: {
    contentType?: string | null;
    fileName?: string | null;
}): boolean;
export declare function imageMimeFromFormat(format?: string | null): string | undefined;
export declare function kindFromMime(mime?: string | null): MediaKind;
