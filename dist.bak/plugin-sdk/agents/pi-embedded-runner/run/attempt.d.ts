import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../../config/config.js";
import type { PluginHookAgentContext, PluginHookBeforeAgentStartResult, PluginHookBeforePromptBuildResult } from "../../../plugins/types.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";
type PromptBuildHookRunner = {
    hasHooks: (hookName: "before_prompt_build" | "before_agent_start") => boolean;
    runBeforePromptBuild: (event: {
        prompt: string;
        messages: unknown[];
    }, ctx: PluginHookAgentContext) => Promise<PluginHookBeforePromptBuildResult | undefined>;
    runBeforeAgentStart: (event: {
        prompt: string;
        messages: unknown[];
    }, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentStartResult | undefined>;
};
export declare function isOllamaCompatProvider(model: {
    provider?: string;
    baseUrl?: string;
    api?: string;
}): boolean;
export declare function resolveOllamaCompatNumCtxEnabled(params: {
    config?: OpenClawConfig;
    providerId?: string;
}): boolean;
export declare function shouldInjectOllamaCompatNumCtx(params: {
    model: {
        api?: string;
        provider?: string;
        baseUrl?: string;
    };
    config?: OpenClawConfig;
    providerId?: string;
}): boolean;
export declare function wrapOllamaCompatNumCtx(baseFn: StreamFn | undefined, numCtx: number): StreamFn;
export declare function wrapStreamFnTrimToolCallNames(baseFn: StreamFn): StreamFn;
export declare function resolvePromptBuildHookResult(params: {
    prompt: string;
    messages: unknown[];
    hookCtx: PluginHookAgentContext;
    hookRunner?: PromptBuildHookRunner | null;
    legacyBeforeAgentStartResult?: PluginHookBeforeAgentStartResult;
}): Promise<PluginHookBeforePromptBuildResult>;
export declare function resolvePromptModeForSession(sessionKey?: string): "minimal" | "full";
export declare function resolveAttemptFsWorkspaceOnly(params: {
    config?: OpenClawConfig;
    sessionAgentId: string;
}): boolean;
export declare function runEmbeddedAttempt(params: EmbeddedRunAttemptParams): Promise<EmbeddedRunAttemptResult>;
export {};
