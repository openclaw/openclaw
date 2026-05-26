import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { type AnyAgentTool, type SandboxFsBridge, type ToolFsPolicy } from "./tool-runtime.helpers.js";
type MusicGenerateSandboxConfig = {
    root: string;
    bridge: SandboxFsBridge;
};
type MusicGenerateBackgroundScheduler = (work: () => Promise<void>) => void;
export declare function createMusicGenerateTool(options?: {
    config?: OpenClawConfig;
    agentDir?: string;
    authProfileStore?: AuthProfileStore;
    agentSessionKey?: string;
    requesterOrigin?: DeliveryContext;
    workspaceDir?: string;
    sandbox?: MusicGenerateSandboxConfig;
    fsPolicy?: ToolFsPolicy;
    scheduleBackgroundWork?: MusicGenerateBackgroundScheduler;
}): AnyAgentTool | null;
export {};
