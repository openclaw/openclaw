import type { VideoGenerationProvider } from "./types.js";
export declare function resolveVideoGenerationSupportedDurations(params: {
    provider?: VideoGenerationProvider;
    model?: string;
    inputImageCount?: number;
    inputVideoCount?: number;
}): number[] | undefined;
export declare function normalizeVideoGenerationDuration(params: {
    provider?: VideoGenerationProvider;
    model?: string;
    durationSeconds?: number;
    inputImageCount?: number;
    inputVideoCount?: number;
}): number | undefined;
