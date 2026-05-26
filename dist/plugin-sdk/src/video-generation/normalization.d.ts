import type { VideoGenerationIgnoredOverride, VideoGenerationNormalization, VideoGenerationProvider, VideoGenerationResolution } from "./types.js";
export type ResolvedVideoGenerationOverrides = {
    size?: string;
    aspectRatio?: string;
    resolution?: VideoGenerationResolution;
    durationSeconds?: number;
    supportedDurationSeconds?: readonly number[];
    audio?: boolean;
    watermark?: boolean;
    ignoredOverrides: VideoGenerationIgnoredOverride[];
    normalization?: VideoGenerationNormalization;
};
export declare function resolveVideoGenerationOverrides(params: {
    provider: VideoGenerationProvider;
    model: string;
    size?: string;
    aspectRatio?: string;
    resolution?: VideoGenerationResolution;
    durationSeconds?: number;
    audio?: boolean;
    watermark?: boolean;
    inputImageCount?: number;
    inputVideoCount?: number;
}): ResolvedVideoGenerationOverrides;
