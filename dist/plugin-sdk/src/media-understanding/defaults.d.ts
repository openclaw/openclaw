import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingCapability, MediaUnderstandingProvider } from "./types.js";
export { CLI_OUTPUT_MAX_BUFFER, DEFAULT_MAX_BYTES, DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS_BY_CAPABILITY, DEFAULT_MEDIA_CONCURRENCY, DEFAULT_PROMPT, DEFAULT_TIMEOUT_SECONDS, DEFAULT_VIDEO_MAX_BASE64_BYTES, MIN_AUDIO_FILE_BYTES, } from "./defaults.constants.js";
export declare function resolveDefaultMediaModel(params: {
    providerId: string;
    capability: MediaUnderstandingCapability;
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): string | undefined;
export declare function resolveAutoMediaKeyProviders(params: {
    capability: MediaUnderstandingCapability;
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): string[];
export declare function providerSupportsNativePdfDocument(params: {
    providerId: string;
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): boolean;
