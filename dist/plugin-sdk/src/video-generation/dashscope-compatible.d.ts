import { postJsonRequest } from "openclaw/plugin-sdk/provider-http";
import type { GeneratedVideoAsset, VideoGenerationRequest, VideoGenerationResult, VideoGenerationSourceAsset } from "./types.js";
export declare const DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL = "wan2.6-t2v";
export declare const DASHSCOPE_WAN_VIDEO_MODELS: string[];
export declare const DASHSCOPE_WAN_VIDEO_CAPABILITIES: {
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
export declare const DEFAULT_VIDEO_GENERATION_DURATION_SECONDS = 5;
export declare const DEFAULT_VIDEO_GENERATION_TIMEOUT_MS = 120000;
export declare const DEFAULT_VIDEO_RESOLUTION_TO_SIZE: Record<string, string>;
export type DashscopeVideoGenerationResponse = {
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
export declare function buildDashscopeVideoGenerationInput(params: {
    providerLabel: string;
    req: VideoGenerationRequest;
}): Record<string, unknown>;
export declare function resolveVideoGenerationReferenceUrls(inputImages: VideoGenerationSourceAsset[] | undefined, inputVideos: VideoGenerationSourceAsset[] | undefined): string[];
export declare function buildDashscopeVideoGenerationParameters(req: VideoGenerationRequest, resolutionToSize?: Record<string, string>): Record<string, unknown> | undefined;
export declare function extractDashscopeVideoUrls(payload: DashscopeVideoGenerationResponse): string[];
export declare function pollDashscopeVideoTaskUntilComplete(params: {
    providerLabel: string;
    taskId: string;
    headers: Headers;
    timeoutMs?: number;
    fetchFn: typeof fetch;
    baseUrl: string;
    defaultTimeoutMs?: number;
}): Promise<DashscopeVideoGenerationResponse>;
export declare function runDashscopeVideoGenerationTask(params: {
    providerLabel: string;
    model: string;
    req: VideoGenerationRequest;
    url: string;
    headers: Headers;
    baseUrl: string;
    timeoutMs?: number;
    fetchFn: typeof fetch;
    allowPrivateNetwork?: boolean;
    dispatcherPolicy?: Parameters<typeof postJsonRequest>[0]["dispatcherPolicy"];
    defaultTimeoutMs?: number;
}): Promise<VideoGenerationResult>;
export declare function downloadDashscopeGeneratedVideos(params: {
    providerLabel: string;
    urls: string[];
    timeoutMs?: number;
    fetchFn: typeof fetch;
    defaultTimeoutMs?: number;
}): Promise<GeneratedVideoAsset[]>;
