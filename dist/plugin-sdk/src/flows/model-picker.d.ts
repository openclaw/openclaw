import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
export { applyPrimaryModel } from "../plugins/provider-model-primary.js";
export type PromptDefaultModelParams = {
    config: OpenClawConfig;
    prompter: WizardPrompter;
    allowKeep?: boolean;
    includeManual?: boolean;
    includeProviderPluginSetups?: boolean;
    ignoreAllowlist?: boolean;
    loadCatalog?: boolean;
    browseCatalogOnDemand?: boolean;
    preferredProvider?: string;
    agentDir?: string;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    runtime?: RuntimeEnv;
    message?: string;
};
export type PromptDefaultModelResult = {
    model?: string;
    config?: OpenClawConfig;
};
export type PromptModelAllowlistResult = {
    models?: string[];
    scopeKeys?: string[];
};
export declare function promptDefaultModel(params: PromptDefaultModelParams): Promise<PromptDefaultModelResult>;
export declare function promptModelAllowlist(params: {
    config: OpenClawConfig;
    prompter: WizardPrompter;
    message?: string;
    agentDir?: string;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    allowedKeys?: string[];
    initialSelections?: string[];
    preferredProvider?: string;
    loadCatalog?: boolean;
}): Promise<PromptModelAllowlistResult>;
export declare function applyModelAllowlist(cfg: OpenClawConfig, models: string[], opts?: {
    scopeKeys?: string[];
}): OpenClawConfig;
export declare function applyModelFallbacksFromSelection(cfg: OpenClawConfig, selection: string[], opts?: {
    scopeKeys?: string[];
}): OpenClawConfig;
