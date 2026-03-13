import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { AuthChoice, OnboardOptions } from "./onboard-types.js";
export type ApplyAuthChoiceParams = {
    authChoice: AuthChoice;
    config: OpenClawConfig;
    prompter: WizardPrompter;
    runtime: RuntimeEnv;
    agentDir?: string;
    setDefaultModel: boolean;
    agentId?: string;
    opts?: Partial<OnboardOptions>;
};
export type ApplyAuthChoiceResult = {
    config: OpenClawConfig;
    agentModelOverride?: string;
};
export declare function applyAuthChoice(params: ApplyAuthChoiceParams): Promise<ApplyAuthChoiceResult>;
