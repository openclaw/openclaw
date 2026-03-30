import type { OpenClawConfig } from "../../config/config.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import type { ToolFsPolicy } from "../tool-fs-policy.js";
import type { AnyAgentTool } from "./common.js";
import { coerceImageAssistantText, decodeDataUrl, type ImageModelConfig } from "./image-tool.helpers.js";
export declare const __testing: {
    readonly decodeDataUrl: typeof decodeDataUrl;
    readonly coerceImageAssistantText: typeof coerceImageAssistantText;
    readonly resolveImageToolMaxTokens: typeof resolveImageToolMaxTokens;
};
declare function resolveImageToolMaxTokens(modelMaxTokens: number | undefined, requestedMaxTokens?: number): number;
/**
 * Resolve the effective image model config for the `image` tool.
 *
 * - Prefer explicit config (`agents.defaults.imageModel`).
 * - Otherwise, try to "pair" the primary model with an image-capable model:
 *   - same provider (best effort)
 *   - fall back to OpenAI/Anthropic when available
 */
export declare function resolveImageModelConfigForTool(params: {
    cfg?: OpenClawConfig;
    agentDir: string;
}): ImageModelConfig | null;
type ImageSandboxConfig = {
    root: string;
    bridge: SandboxFsBridge;
};
export declare function createImageTool(options?: {
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    sandbox?: ImageSandboxConfig;
    fsPolicy?: ToolFsPolicy;
    /** If true, the model has native vision capability and images in the prompt are auto-injected */
    modelHasVision?: boolean;
}): AnyAgentTool | null;
export {};
