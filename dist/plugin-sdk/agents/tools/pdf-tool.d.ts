import type { OpenClawConfig } from "../../config/config.js";
import { type ImageModelConfig } from "./image-tool.helpers.js";
import { type AnyAgentTool, type SandboxFsBridge, type ToolFsPolicy } from "./tool-runtime.helpers.js";
/**
 * Resolve the effective PDF model config.
 * Falls back to the image model config, then to provider-specific defaults.
 */
export declare function resolvePdfModelConfigForTool(params: {
    cfg?: OpenClawConfig;
    agentDir: string;
}): ImageModelConfig | null;
type PdfSandboxConfig = {
    root: string;
    bridge: SandboxFsBridge;
};
export declare function createPdfTool(options?: {
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    sandbox?: PdfSandboxConfig;
    fsPolicy?: ToolFsPolicy;
}): AnyAgentTool | null;
export {};
