import type { OpenClawConfig } from "../config/types.js";
import { parseProviderModelMap, redactLiveApiKey } from "../media-generation/live-test-helpers.js";
export { parseProviderModelMap, redactLiveApiKey };
export declare const DEFAULT_LIVE_VIDEO_MODELS: Record<string, string>;
export declare function resolveLiveVideoResolution(params: {
    providerId: string;
    modelRef: string;
}): "480P" | "720P" | "768P" | "1080P";
export declare function parseCsvFilter(raw?: string): Set<string> | null;
export declare function resolveConfiguredLiveVideoModels(cfg: OpenClawConfig): Map<string, string>;
export declare function canRunBufferBackedVideoToVideoLiveLane(params: {
    providerId: string;
    modelRef: string;
}): boolean;
export declare function canRunBufferBackedImageToVideoLiveLane(params: {
    providerId: string;
    modelRef: string;
}): boolean;
export declare function resolveLiveVideoAuthStore(params: {
    requireProfileKeys: boolean;
    hasLiveKeys: boolean;
}): import("openclaw/plugin-sdk/provider-auth").AuthProfileStore | undefined;
