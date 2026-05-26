import { c as MusicGenerationProvider } from "../../types-M_PrR5fi.js";
import { o as VideoGenerationProvider } from "../../video-generation-BzlZ07CN.js";
//#region extensions/google/generation-provider-metadata.d.ts
declare const DEFAULT_GOOGLE_MUSIC_MODEL = "lyria-3-clip-preview";
declare const GOOGLE_PRO_MUSIC_MODEL = "lyria-3-pro-preview";
declare const GOOGLE_MAX_INPUT_IMAGES = 10;
declare const DEFAULT_GOOGLE_VIDEO_MODEL = "veo-3.1-fast-generate-preview";
declare const GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS: readonly [4, 6, 8];
declare const GOOGLE_VIDEO_MIN_DURATION_SECONDS: 4;
declare const GOOGLE_VIDEO_MAX_DURATION_SECONDS: 6 | 4 | 8;
declare function createGoogleMusicGenerationProviderMetadata(): Omit<MusicGenerationProvider, "generateMusic">;
declare function createGoogleVideoGenerationProviderMetadata(): Omit<VideoGenerationProvider, "generateVideo">;
//#endregion
export { DEFAULT_GOOGLE_MUSIC_MODEL, DEFAULT_GOOGLE_VIDEO_MODEL, GOOGLE_MAX_INPUT_IMAGES, GOOGLE_PRO_MUSIC_MODEL, GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS, GOOGLE_VIDEO_MAX_DURATION_SECONDS, GOOGLE_VIDEO_MIN_DURATION_SECONDS, createGoogleMusicGenerationProviderMetadata, createGoogleVideoGenerationProviderMetadata };