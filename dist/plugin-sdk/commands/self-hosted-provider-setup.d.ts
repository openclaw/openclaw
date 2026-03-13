import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ProviderAuthMethodNonInteractiveContext } from "../plugins/types.js";
import type { WizardPrompter } from "../wizard/prompts.js";
export declare const SELF_HOSTED_DEFAULT_CONTEXT_WINDOW = 128000;
export declare const SELF_HOSTED_DEFAULT_MAX_TOKENS = 8192;
export declare const SELF_HOSTED_DEFAULT_COST: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};
export declare function applyProviderDefaultModel(cfg: OpenClawConfig, modelRef: string): OpenClawConfig;
export declare function promptAndConfigureOpenAICompatibleSelfHostedProvider(params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    providerId: string;
    providerLabel: string;
    defaultBaseUrl: string;
    defaultApiKeyEnvVar: string;
    modelPlaceholder: string;
    input?: Array<"text" | "image">;
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
}): Promise<{
    config: OpenClawConfig;
    credential: AuthProfileCredential;
    modelId: string;
    modelRef: string;
    profileId: string;
}>;
export declare function configureOpenAICompatibleSelfHostedProviderNonInteractive(params: {
    ctx: ProviderAuthMethodNonInteractiveContext;
    providerId: string;
    providerLabel: string;
    defaultBaseUrl: string;
    defaultApiKeyEnvVar: string;
    modelPlaceholder: string;
    input?: Array<"text" | "image">;
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
}): Promise<OpenClawConfig | null>;
