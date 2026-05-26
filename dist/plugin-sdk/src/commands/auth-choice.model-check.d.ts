import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";
export declare function warnIfModelConfigLooksOff(config: OpenClawConfig, prompter: WizardPrompter, options?: {
    agentId?: string;
    agentDir?: string;
    validateCatalog?: boolean;
}): Promise<void>;
