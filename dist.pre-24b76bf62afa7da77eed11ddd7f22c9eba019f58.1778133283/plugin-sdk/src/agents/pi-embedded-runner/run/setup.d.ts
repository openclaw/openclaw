import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import type { PluginHookBeforeAgentStartResult, PluginHookBeforeModelResolveAttachment, PluginHookBeforeModelResolveEvent } from "../../../plugins/types.js";
import { type ContextWindowInfo } from "../../context-window-guard.js";
type HookContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId: string;
    workspaceDir: string;
    messageProvider?: string;
    trigger?: string;
    channelId?: string;
};
type HookRunnerLike = {
    hasHooks(hookName: string): boolean;
    runBeforeModelResolve(input: PluginHookBeforeModelResolveEvent, context: HookContext): Promise<{
        providerOverride?: string;
        modelOverride?: string;
    } | undefined>;
    runBeforeAgentStart(input: {
        prompt: string;
    }, context: HookContext): Promise<PluginHookBeforeAgentStartResult | undefined>;
};
export declare function resolveHookModelSelection(params: {
    prompt: string;
    attachments?: PluginHookBeforeModelResolveAttachment[];
    provider: string;
    modelId: string;
    hookRunner?: HookRunnerLike | null;
    hookContext: HookContext;
}): Promise<{
    provider: string;
    modelId: string;
    legacyBeforeAgentStartResult: PluginHookBeforeAgentStartResult | undefined;
}>;
export declare function buildBeforeModelResolveAttachments(images: readonly {
    mimeType?: string;
}[] | undefined): PluginHookBeforeModelResolveAttachment[] | undefined;
export declare function resolveEffectiveRuntimeModel(params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    modelId: string;
    runtimeModel: ProviderRuntimeModel;
}): {
    ctxInfo: ContextWindowInfo;
    effectiveModel: ProviderRuntimeModel;
};
export {};
