import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type MediaGenerateActionResult } from "./media-generate-tool-actions-shared.js";
type VideoGenerateActionResult = MediaGenerateActionResult;
export declare function createVideoGenerateListActionResult(config?: OpenClawConfig): VideoGenerateActionResult;
export declare function createVideoGenerateStatusActionResult(sessionKey?: string): VideoGenerateActionResult;
export declare function createVideoGenerateDuplicateGuardResult(sessionKey?: string): VideoGenerateActionResult | undefined;
export {};
