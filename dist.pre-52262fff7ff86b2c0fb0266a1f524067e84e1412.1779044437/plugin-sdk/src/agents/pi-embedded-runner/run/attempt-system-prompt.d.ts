import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderTransformSystemPromptContext } from "../../../plugins/types.js";
import { buildEmbeddedSystemPrompt } from "../system-prompt.js";
type EmbeddedSystemPromptParams = Parameters<typeof buildEmbeddedSystemPrompt>[0];
type ProviderSystemPromptTransform = (params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir: string;
    context: ProviderTransformSystemPromptContext;
}) => string;
export type BuildAttemptSystemPromptParams = {
    isRawModelRun: boolean;
    systemPromptOverrideText?: string;
    embeddedSystemPrompt: EmbeddedSystemPromptParams;
    transformProviderSystemPrompt: ProviderSystemPromptTransform;
    providerTransform: {
        provider: string;
        config?: OpenClawConfig;
        workspaceDir: string;
        context: Omit<ProviderTransformSystemPromptContext, "systemPrompt">;
    };
};
export type AttemptSystemPrompt = {
    baseSystemPrompt: string;
    systemPrompt: string;
    systemPromptOverride: (defaultPrompt?: string) => string;
};
export declare function buildAttemptSystemPrompt(params: BuildAttemptSystemPromptParams): AttemptSystemPrompt;
export {};
