import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type MediaGenerateActionResult } from "./media-generate-tool-actions-shared.js";
type MusicGenerateActionResult = MediaGenerateActionResult;
export declare function createMusicGenerateListActionResult(config?: OpenClawConfig): MusicGenerateActionResult;
export declare function createMusicGenerateStatusActionResult(sessionKey?: string): MusicGenerateActionResult;
export declare function createMusicGenerateDuplicateGuardResult(sessionKey?: string): MusicGenerateActionResult | undefined;
export {};
