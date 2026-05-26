import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { type ToolModelConfig } from "./model-config.helpers.js";
import { type AnyAgentTool, type SandboxFsBridge, type ToolFsPolicy } from "./tool-runtime.helpers.js";
export declare function resolveVideoGenerationModelConfigForTool(params: {
    cfg?: OpenClawConfig;
    agentDir?: string;
    authStore?: AuthProfileStore;
}): ToolModelConfig | null;
type VideoGenerateSandboxConfig = {
    root: string;
    bridge: SandboxFsBridge;
};
type VideoGenerateBackgroundScheduler = (work: () => Promise<void>) => void;
export declare function createVideoGenerateTool(options?: {
    config?: OpenClawConfig;
    agentDir?: string;
    authProfileStore?: AuthProfileStore;
    agentSessionKey?: string;
    requesterOrigin?: DeliveryContext;
    workspaceDir?: string;
    sandbox?: VideoGenerateSandboxConfig;
    fsPolicy?: ToolFsPolicy;
    scheduleBackgroundWork?: VideoGenerateBackgroundScheduler;
}): AnyAgentTool | null;
export {};
