export declare const MAX_IMAGE_BYTES: number;
export declare const MAX_AUDIO_BYTES: number;
export declare const MAX_VIDEO_BYTES: number;
export declare const MAX_DOCUMENT_BYTES: number;
export type MediaKind = "image" | "audio" | "video" | "document";
export declare function mediaKindFromMime(mime?: string | null): MediaKind | undefined;
export declare function maxBytesForKind(kind: MediaKind): number;
