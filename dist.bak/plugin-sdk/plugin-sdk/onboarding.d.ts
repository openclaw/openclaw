import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
export type PromptAccountIdParams = {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    label: string;
    currentId?: string;
    listAccountIds: (cfg: OpenClawConfig) => string[];
    defaultAccountId: string;
};
export declare function promptAccountId(params: PromptAccountIdParams): Promise<string>;
