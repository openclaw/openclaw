import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GenerateVideoParams } from "./runtime-types.js";
import type { VideoGenerationProvider, VideoGenerationProviderCapabilities } from "./types.js";
export declare function buildReferenceInputCapabilityFailure(params: {
    providerId: string;
    model: string;
    provider: VideoGenerationProvider;
    inputImageCount: number;
    inputVideoCount: number;
    inputAudioCount: number;
}): string | undefined;
export declare function mergeVideoGenerationProviderCapabilities(base: VideoGenerationProviderCapabilities, overlay: VideoGenerationProviderCapabilities): VideoGenerationProviderCapabilities;
export declare function resolveProviderWithModelCapabilities(params: {
    provider: VideoGenerationProvider;
    providerId: string;
    model: string;
    cfg: OpenClawConfig;
    agentDir?: string;
    authStore?: GenerateVideoParams["authStore"];
    timeoutMs?: number;
    log: Pick<Console, "debug">;
}): Promise<VideoGenerationProvider>;
