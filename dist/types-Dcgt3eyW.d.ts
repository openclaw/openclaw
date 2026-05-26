import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as AuthProfileStore } from "./types-BwDj5PsX.js";
import { n as MediaNormalizationEntry } from "./normalization.types-BKVXCo7w.js";

//#region src/video-generation/types.d.ts
type GeneratedVideoAsset = {
  /** Raw video bytes. Required for local delivery; omit when url is provided instead. */buffer?: Buffer;
  /** External URL for the video (for example a pre-signed cloud storage URL).
   * When set and buffer is absent, delivery surfaces can forward the URL
   * without downloading the full video into memory first. */
  url?: string;
  mimeType: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};
type VideoGenerationResolution = "480P" | "720P" | "768P" | "1080P" | (string & {});
/**
 * Canonical semantic role hints for reference assets. The list covers the
 * near-universal I2V vocabulary plus per-kind reference roles. Providers may
 * accept additional role strings (extend the asset.role type with a plain
 * string at call sites) — core forwards whatever value is set.
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
   * provider-specific extensions. Core does not validate the value beyond
   * shape.
   */
  role?: VideoGenerationAssetRole | (string & {});
  metadata?: Record<string, unknown>;
};
type VideoGenerationProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  agentDir?: string;
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
  durationSeconds?: number; /** Enable generated audio in the output when the provider supports it. Distinct from inputAudios (reference audio input). */
  audio?: boolean;
  watermark?: boolean;
  inputImages?: VideoGenerationSourceAsset[];
  inputVideos?: VideoGenerationSourceAsset[]; /** Reference audio assets (e.g. background music). Role field on each asset is forwarded to the provider as-is. */
  inputAudios?: VideoGenerationSourceAsset[]; /** Arbitrary provider-specific options forwarded as-is to provider.generateVideo. Core does not validate or log the contents. */
  providerOptions?: Record<string, unknown>;
};
type VideoGenerationModelCapabilitiesContext = {
  provider: string;
  model: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
};
type VideoGenerationResult = {
  videos: GeneratedVideoAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
};
type VideoGenerationIgnoredOverride = {
  key: "size" | "aspectRatio" | "resolution" | "audio" | "watermark";
  value: string | boolean;
};
type VideoGenerationMode = "generate" | "imageToVideo" | "videoToVideo";
/**
 * Primitive type tag for a declared `providerOptions` key. Core validates
 * the agent-supplied value against this tag before forwarding it to the
 * provider. Kept deliberately narrow — plugins that need richer shapes
 * should keep those fields out of the typed contract and reinterpret the
 * forwarded opaque value inside their own provider code.
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
  supportsResolution?: boolean; /** Provider can generate audio in the output video. */
  supportsAudio?: boolean;
  supportsWatermark?: boolean;
  /**
   * Declared typed schema for the opaque `VideoGenerationRequest.providerOptions`
   * bag. Keys listed here are accepted; any other keys the agent passes are
   * rejected at the runtime fallback boundary so mis-typed or provider-specific
   * options never silently reach the wrong provider. Plugins that currently
   * accept no providerOptions should leave this undefined or set to `{}`.
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
type VideoGenerationNormalization = {
  size?: MediaNormalizationEntry<string>;
  aspectRatio?: MediaNormalizationEntry<string>;
  resolution?: MediaNormalizationEntry<VideoGenerationResolution>;
  durationSeconds?: MediaNormalizationEntry<number>;
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
export { VideoGenerationModelCapabilitiesContext as a, VideoGenerationProviderCapabilities as c, VideoGenerationResolution as d, VideoGenerationResult as f, VideoGenerationModeCapabilities as i, VideoGenerationProviderConfiguredContext as l, VideoGenerationTransformCapabilities as m, VideoGenerationIgnoredOverride as n, VideoGenerationNormalization as o, VideoGenerationSourceAsset as p, VideoGenerationMode as r, VideoGenerationProvider as s, GeneratedVideoAsset as t, VideoGenerationRequest as u };