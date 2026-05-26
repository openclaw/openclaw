import type { VideoGenerationMode, VideoGenerationModeCapabilities, VideoGenerationProvider, VideoGenerationTransformCapabilities } from "./types.js";
export declare function resolveVideoGenerationMode(params: {
    inputImageCount?: number;
    inputVideoCount?: number;
}): VideoGenerationMode | null;
export declare function listSupportedVideoGenerationModes(provider: Pick<VideoGenerationProvider, "capabilities">): VideoGenerationMode[];
export declare function resolveVideoGenerationModeCapabilities(params: {
    provider?: Pick<VideoGenerationProvider, "capabilities">;
    model?: string;
    inputImageCount?: number;
    inputVideoCount?: number;
}): {
    mode: VideoGenerationMode | null;
    capabilities: VideoGenerationModeCapabilities | VideoGenerationTransformCapabilities | undefined;
};
