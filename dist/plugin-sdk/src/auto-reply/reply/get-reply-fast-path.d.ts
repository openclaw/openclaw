import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import type { CommandContext } from "./commands-types.js";
import type { SessionInitResult } from "./session.js";
export declare function markCompleteReplyConfig<T extends OpenClawConfig>(config: T, options?: {
    runtimeMode?: "fast" | "full";
}): T;
export declare function withFastReplyConfig<T extends OpenClawConfig>(config: T): T;
export declare function withFullRuntimeReplyConfig<T extends OpenClawConfig>(config: T): T;
export declare function resolveGetReplyConfig(params: {
    getRuntimeConfig: () => OpenClawConfig;
    isFastTestEnv: boolean;
    configOverride?: OpenClawConfig;
}): OpenClawConfig;
export declare function shouldUseReplyFastTestBootstrap(params: {
    isFastTestEnv: boolean;
    configOverride?: OpenClawConfig;
}): boolean;
export declare function shouldUseReplyFastTestRuntime(params: {
    cfg: OpenClawConfig;
    isFastTestEnv: boolean;
}): boolean;
export declare function shouldUseReplyFastDirectiveExecution(params: {
    isFastTestBootstrap: boolean;
    isGroup: boolean;
    isHeartbeat: boolean;
    resetTriggered: boolean;
    triggerBodyNormalized: string;
}): boolean;
export declare function buildFastReplyCommandContext(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    isGroup: boolean;
    triggerBodyNormalized: string;
    commandAuthorized: boolean;
}): CommandContext;
export declare function shouldHandleFastReplyTextCommands(params: {
    cfg: OpenClawConfig;
    commandSource?: string;
}): boolean;
export declare function initFastReplySessionState(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
    agentId: string;
    commandAuthorized: boolean;
    workspaceDir: string;
}): SessionInitResult;
