import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
type PromptDefaultModelParams = {
    config: OpenClawConfig;
    prompter: WizardPrompter;
    allowKeep?: boolean;
    includeManual?: boolean;
    includeProviderPluginSetups?: boolean;
    ignoreAllowlist?: boolean;
    preferredProvider?: string;
    agentDir?: string;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    runtime?: import("../runtime.js").RuntimeEnv;
    message?: string;
};
type PromptDefaultModelResult = {
    model?: string;
    config?: OpenClawConfig;
};
type PromptModelAllowlistResult = {
    models?: string[];
};
export declare function promptDefaultModel(params: PromptDefaultModelParams): Promise<PromptDefaultModelResult>;
export declare function promptModelAllowlist(params: {
    config: OpenClawConfig;
    prompter: WizardPrompter;
    message?: string;
    agentDir?: string;
    allowedKeys?: string[];
    initialSelections?: string[];
}): Promise<PromptModelAllowlistResult>;
export declare function applyPrimaryModel(cfg: OpenClawConfig, model: string): OpenClawConfig;
export declare function applyModelAllowlist(cfg: OpenClawConfig, models: string[]): OpenClawConfig;
export declare function applyModelFallbacksFromSelection(cfg: OpenClawConfig, selection: string[]): OpenClawConfig;
export {};
