//#region src/media/constants.d.ts
declare const MAX_IMAGE_BYTES: number;
declare const MAX_AUDIO_BYTES: number;
declare const MAX_VIDEO_BYTES: number;
declare const MAX_DOCUMENT_BYTES: number;
type MediaKind = "image" | "audio" | "video" | "document";
declare function mediaKindFromMime(mime?: string | null): MediaKind | undefined;
declare function maxBytesForKind(kind: MediaKind): number;
//#endregion
export { MediaKind as a, MAX_VIDEO_BYTES as i, MAX_DOCUMENT_BYTES as n, maxBytesForKind as o, MAX_IMAGE_BYTES as r, mediaKindFromMime as s, MAX_AUDIO_BYTES as t };