import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
export declare function applyDefaultModelChoice(params: {
    config: OpenClawConfig;
    setDefaultModel: boolean;
    defaultModel: string;
    applyDefaultConfig: (config: OpenClawConfig) => OpenClawConfig;
    applyProviderConfig: (config: OpenClawConfig) => OpenClawConfig;
    noteDefault?: string;
    noteAgentModel: (model: string) => Promise<void>;
    prompter: WizardPrompter;
}): Promise<{
    config: OpenClawConfig;
    agentModelOverride?: string;
}>;
