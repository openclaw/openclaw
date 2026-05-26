import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { type MediaGenerateActionResult } from "./media-generate-tool-actions-shared.js";
type MusicGenerateActionResult = MediaGenerateActionResult;
export declare function createMusicGenerateListActionResult(config?: OpenClawConfig, options?: {
    workspaceDir?: string;
    agentDir?: string;
    authStore?: AuthProfileStore;
}): MusicGenerateActionResult;
export declare function createMusicGenerateStatusActionResult(sessionKey?: string): MusicGenerateActionResult;
export declare function createMusicGenerateDuplicateGuardResult(sessionKey?: string, params?: {
    prompt?: string;
    requestKey?: string;
}): MusicGenerateActionResult | undefined;
export {};
