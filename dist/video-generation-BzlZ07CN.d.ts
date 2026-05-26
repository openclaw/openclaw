import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as AuthProfileStore } from "./types-BwDj5PsX.js";
import { f as VideoGenerationResult$1, p as VideoGenerationSourceAsset$1, t as GeneratedVideoAsset$1, u as VideoGenerationRequest$1 } from "./types-Dcgt3eyW.js";
import { n as ProviderOperationTimeoutMs, u as postJsonRequest } from "./provider-http-ByynA2MJ.js";

//#region src/video-generation/dashscope-compatible.d.ts
declare const DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL = "wan2.6-t2v";
declare const DASHSCOPE_WAN_VIDEO_MODELS: string[];
declare const DASHSCOPE_WAN_VIDEO_CAPABILITIES: {
  generate: {
    maxVideos: number;
    maxDurationSeconds: number;
    supportsSize: true;
    supportsAspectRatio: true;
    supportsResolution: true;
    supportsAudio: true;
    supportsWatermark: true;
  };
  imageToVideo: {
    enabled: true;
    maxVideos: number;
    maxInputImages: number;
    maxDurationSeconds: number;
    supportsSize: true;
    supportsAspectRatio: true;
    supportsResolution: true;
    supportsAudio: true;
    supportsWatermark: true;
  };
  videoToVideo: {
    enabled: true;
    maxVideos: number;
    maxInputVideos: number;
    maxDurationSeconds: number;
    supportsSize: true;
    supportsAspectRatio: true;
    supportsResolution: true;
    supportsAudio: true;
    supportsWatermark: true;
  };
};
declare const DEFAULT_VIDEO_GENERATION_DURATION_SECONDS = 5;
declare const DEFAULT_VIDEO_GENERATION_TIMEOUT_MS = 120000;
declare const DEFAULT_VIDEO_RESOLUTION_TO_SIZE: Record<string, string>;
type DashscopeVideoGenerationResponse = {
  output?: {
    task_id?: string;
    task_status?: string;
    submit_time?: string;
    results?: Array<{
      video_url?: string;
      orig_prompt?: string;
      actual_prompt?: string;
    }>;
    video_url?: string;
    code?: string;
    message?: string;
  };
  request_id?: string;
  code?: string;
  message?: string;
};
declare function buildDashscopeVideoGenerationInput(params: {
  providerLabel: string;
  req: VideoGenerationRequest$1;
}): Record<string, unknown>;
declare function resolveVideoGenerationReferenceUrls(inputImages: VideoGenerationSourceAsset$1[] | undefined, inputVideos: VideoGenerationSourceAsset$1[] | undefined): string[];
declare function buildDashscopeVideoGenerationParameters(req: VideoGenerationRequest$1, resolutionToSize?: Record<string, string>): Record<string, unknown> | undefined;
declare function extractDashscopeVideoUrls(payload: DashscopeVideoGenerationResponse): string[];
declare function pollDashscopeVideoTaskUntilComplete(params: {
  providerLabel: string;
  taskId: string;
  headers: Headers;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  baseUrl: string;
  defaultTimeoutMs?: number;
}): Promise<DashscopeVideoGenerationResponse>;
declare function runDashscopeVideoGenerationTask(params: {
  providerLabel: string;
  model: string;
  req: VideoGenerationRequest$1;
  url: string;
  headers: Headers;
  baseUrl: string;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  allowPrivateNetwork?: boolean;
  dispatcherPolicy?: Parameters<typeof postJsonRequest>[0]["dispatcherPolicy"];
  defaultTimeoutMs?: number;
}): Promise<VideoGenerationResult$1>;
declare function downloadDashscopeGeneratedVideos(params: {
  providerLabel: string;
  urls: string[];
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  defaultTimeoutMs?: number;
}): Promise<GeneratedVideoAsset$1[]>;
//#endregion
//#region src/plugin-sdk/video-generation.d.ts
type GeneratedVideoAsset = {
  /** Raw video bytes. Either buffer or url must be present. */buffer?: Buffer;
  /** Pre-signed or provider-hosted URL for the video. When set and buffer is
   * absent, callers can deliver or download the asset without requiring the
   * provider to materialize the full file in memory first. */
  url?: string;
  mimeType: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};
type VideoGenerationResolution = "480P" | "720P" | "768P" | "1080P" | (string & {});
/**
 * Canonical semantic role hints for reference assets (first/last frame,
 * reference image/video/audio). Providers may accept additional role strings;
 * the asset.role type accepts both canonical values and arbitrary strings.
 */
type VideoGenerationAssetRole = "first_frame" | "last_frame" | "reference_image" | "reference_video" | "reference_audio";
type VideoGenerationSourceAsset = {
  url?: string;
  buffer?: Buffer;
  mimeType?: string;
  fileName?: string;
  /**
   * Optional semantic role hint forwarded to the provider. Canonical values
   * come from `VideoGenerationAssetRole`; plain strings are accepted for
   * provider-specific extensions.
   */
  role?: VideoGenerationAssetRole | (string & {});
  metadata?: Record<string, unknown>;
};
type VideoGenerationProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  agentDir?: string;
};
type VideoGenerationModelCapabilitiesContext = {
  provider: string;
  model: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
};
type VideoGenerationRequest = {
  provider: string;
  model: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  inputImages?: VideoGenerationSourceAsset[];
  inputVideos?: VideoGenerationSourceAsset[]; /** Reference audio assets (e.g. background music) forwarded to the provider. */
  inputAudios?: VideoGenerationSourceAsset[]; /** Arbitrary provider-specific parameters forwarded as-is (e.g. seed, draft, camerafixed). */
  providerOptions?: Record<string, unknown>;
};
type VideoGenerationResult = {
  videos: GeneratedVideoAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
};
type VideoGenerationMode = "generate" | "imageToVideo" | "videoToVideo";
/**
 * Primitive type tag for a declared `providerOptions` key. Keep narrow —
 * plugins that need richer shapes should leave them out of the typed contract
 * and interpret the forwarded opaque value inside their own provider code.
 */
type VideoGenerationProviderOptionType = "number" | "boolean" | "string";
type VideoGenerationModeCapabilities = {
  maxVideos?: number;
  maxInputImages?: number;
  maxInputImagesByModel?: Readonly<Record<string, number>>;
  maxInputVideos?: number;
  maxInputVideosByModel?: Readonly<Record<string, number>>; /** Max number of reference audio assets the provider accepts (e.g. background music, voice reference). */
  maxInputAudios?: number;
  maxInputAudiosByModel?: Readonly<Record<string, number>>;
  maxDurationSeconds?: number;
  supportedDurationSeconds?: readonly number[];
  supportedDurationSecondsByModel?: Readonly<Record<string, readonly number[]>>;
  sizes?: readonly string[];
  aspectRatios?: readonly string[];
  resolutions?: readonly VideoGenerationResolution[];
  supportsSize?: boolean;
  supportsAspectRatio?: boolean;
  supportsResolution?: boolean;
  supportsAudio?: boolean;
  supportsWatermark?: boolean;
  /**
   * Declared typed schema for `VideoGenerationRequest.providerOptions`. Keys
   * listed here are accepted and validated against the declared primitive
   * type before forwarding; unknown keys or type mismatches skip the
   * candidate provider at runtime so mis-typed or provider-specific options
   * never silently reach the wrong provider.
   */
  providerOptions?: Readonly<Record<string, VideoGenerationProviderOptionType>>;
};
type VideoGenerationTransformCapabilities = VideoGenerationModeCapabilities & {
  enabled: boolean;
};
type VideoGenerationProviderCapabilities = VideoGenerationModeCapabilities & {
  generate?: VideoGenerationModeCapabilities;
  imageToVideo?: VideoGenerationTransformCapabilities;
  videoToVideo?: VideoGenerationTransformCapabilities;
};
type VideoGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string; /** Default provider operation timeout in milliseconds when caller/config omit timeoutMs. */
  defaultTimeoutMs?: number;
  models?: string[];
  capabilities: VideoGenerationProviderCapabilities;
  isConfigured?: (ctx: VideoGenerationProviderConfiguredContext) => boolean;
  resolveModelCapabilities?: (ctx: VideoGenerationModelCapabilitiesContext) => VideoGenerationProviderCapabilities | undefined | Promise<VideoGenerationProviderCapabilities | undefined>;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};
//#endregion
export { buildDashscopeVideoGenerationParameters as C, resolveVideoGenerationReferenceUrls as D, pollDashscopeVideoTaskUntilComplete as E, runDashscopeVideoGenerationTask as O, buildDashscopeVideoGenerationInput as S, extractDashscopeVideoUrls as T, DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL as _, VideoGenerationModelCapabilitiesContext as a, DEFAULT_VIDEO_RESOLUTION_TO_SIZE as b, VideoGenerationProviderConfiguredContext as c, VideoGenerationResolution as d, VideoGenerationResult as f, DASHSCOPE_WAN_VIDEO_MODELS as g, DASHSCOPE_WAN_VIDEO_CAPABILITIES as h, VideoGenerationModeCapabilities as i, VideoGenerationProviderOptionType as l, VideoGenerationTransformCapabilities as m, VideoGenerationAssetRole as n, VideoGenerationProvider as o, VideoGenerationSourceAsset as p, VideoGenerationMode as r, VideoGenerationProviderCapabilities as s, GeneratedVideoAsset as t, VideoGenerationRequest as u, DEFAULT_VIDEO_GENERATION_DURATION_SECONDS as v, downloadDashscopeGeneratedVideos as w, DashscopeVideoGenerationResponse as x, DEFAULT_VIDEO_GENERATION_TIMEOUT_MS as y };