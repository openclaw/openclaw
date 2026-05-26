import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ImageGenerationProvider } from "../../image-generation/types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { type MediaGenerateActionResult } from "./media-generate-tool-actions-shared.js";
export type ImageGenerateActionResult = MediaGenerateActionResult;
export declare function formatImageGenerationAuthHint(provider: {
    id: string;
    authEnvVars: readonly string[];
}): string | undefined;
export declare function listSupportedImageGenerationModes(provider: ImageGenerationProvider): string[];
export declare function summarizeImageGenerationCapabilities(provider: ImageGenerationProvider): string;
export declare function createImageGenerateListActionResult(params: {
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    agentDir?: string;
    authStore?: AuthProfileStore;
}): ImageGenerateActionResult;
export declare function createImageGenerateStatusActionResult(sessionKey?: string): ImageGenerateActionResult;
export declare function createImageGenerateDuplicateGuardResult(sessionKey?: string, params?: {
    prompt?: string;
    requestKey?: string;
}): ImageGenerateActionResult | undefined;
