import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type { MusicGenerationProvider } from "openclaw/plugin-sdk/music-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import type {
  VideoGenerationModeCapabilities,
  VideoGenerationProvider,
  VideoGenerationProviderConfiguredContext,
} from "openclaw/plugin-sdk/video-generation";

export const DEFAULT_GOOGLE_IMAGE_MODEL = "gemini-3.1-flash-image";
export const GOOGLE_MAX_IMAGE_RESULTS = 4;

export const GOOGLE_MEDIA_UNDERSTANDING_DEFAULT_MODELS = {
  image: "gemini-3-flash-preview",
  audio: "gemini-3-flash-preview",
  video: "gemini-3-flash-preview",
} as const;

export const DEFAULT_GOOGLE_MUSIC_MODEL = "lyria-3-clip-preview";
export const GOOGLE_PRO_MUSIC_MODEL = "lyria-3-pro-preview";
export const GOOGLE_MAX_INPUT_IMAGES = 10;

export const DEFAULT_GOOGLE_VIDEO_MODEL = "veo-3.1-fast-generate-preview";
export const GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS = [4, 6, 8] as const;
export const GOOGLE_VIDEO_MIN_DURATION_SECONDS = GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS[0];
export const GOOGLE_VIDEO_MAX_DURATION_SECONDS = GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS[2];

function isGoogleProviderConfigured(ctx: VideoGenerationProviderConfiguredContext): boolean {
  return isProviderApiKeyConfigured({ provider: "google", ...ctx });
}

function createGoogleVideoCommonCapabilities() {
  return {
    maxDurationSeconds: GOOGLE_VIDEO_MAX_DURATION_SECONDS,
    supportedDurationSeconds: [...GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["720P", "1080P"],
    supportsAspectRatio: true,
    supportsResolution: true,
    supportsSize: true,
    supportsAudio: false,
  } satisfies VideoGenerationModeCapabilities;
}

export function createGoogleImageGenerationProviderMetadata(): Omit<
  ImageGenerationProvider,
  "generateImage" | "isConfigured"
> {
  return {
    id: "google",
    label: "Google",
    defaultModel: DEFAULT_GOOGLE_IMAGE_MODEL,
    models: [DEFAULT_GOOGLE_IMAGE_MODEL, "gemini-3-pro-image"],
    capabilities: {
      generate: {
        maxCount: GOOGLE_MAX_IMAGE_RESULTS,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: GOOGLE_MAX_IMAGE_RESULTS,
        maxInputImages: 5,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        sizes: ["1024x1024", "1024x1536", "1536x1024", "1024x1792", "1792x1024"],
        aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
        resolutions: ["1K", "2K", "4K"],
      },
    },
  };
}

export function createGoogleMediaUnderstandingProviderMetadata(): Omit<
  MediaUnderstandingProvider,
  "transcribeAudio" | "describeVideo"
> {
  return {
    id: "google",
    capabilities: ["image", "audio", "video"],
    defaultModels: { ...GOOGLE_MEDIA_UNDERSTANDING_DEFAULT_MODELS },
    autoPriority: { image: 30, audio: 40, video: 10 },
    nativeDocumentInputs: ["pdf"],
    describeImage: undefined,
    describeImages: undefined,
  };
}

export function createGoogleMusicGenerationProviderMetadata(): Omit<
  MusicGenerationProvider,
  "generateMusic"
> {
  return {
    id: "google",
    label: "Google",
    defaultModel: DEFAULT_GOOGLE_MUSIC_MODEL,
    models: [DEFAULT_GOOGLE_MUSIC_MODEL, GOOGLE_PRO_MUSIC_MODEL],
    isConfigured: isGoogleProviderConfigured,
    capabilities: {
      generate: {
        maxTracks: 1,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsFormat: true,
        supportedFormatsByModel: {
          [DEFAULT_GOOGLE_MUSIC_MODEL]: ["mp3"],
          [GOOGLE_PRO_MUSIC_MODEL]: ["mp3", "wav"],
        },
      },
      edit: {
        enabled: true,
        maxTracks: 1,
        maxInputImages: GOOGLE_MAX_INPUT_IMAGES,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsFormat: true,
        supportedFormatsByModel: {
          [DEFAULT_GOOGLE_MUSIC_MODEL]: ["mp3"],
          [GOOGLE_PRO_MUSIC_MODEL]: ["mp3", "wav"],
        },
      },
    },
  };
}

export function createGoogleVideoGenerationProviderMetadata(): Omit<
  VideoGenerationProvider,
  "generateVideo"
> {
  return {
    id: "google",
    label: "Google",
    defaultModel: DEFAULT_GOOGLE_VIDEO_MODEL,
    models: [
      DEFAULT_GOOGLE_VIDEO_MODEL,
      "veo-3.1-generate-preview",
      "veo-3.1-lite-generate-preview",
    ],
    isConfigured: isGoogleProviderConfigured,
    capabilities: {
      generate: {
        maxVideos: 1,
        ...createGoogleVideoCommonCapabilities(),
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        ...createGoogleVideoCommonCapabilities(),
      },
      videoToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputVideos: 1,
        ...createGoogleVideoCommonCapabilities(),
      },
    },
  };
}
