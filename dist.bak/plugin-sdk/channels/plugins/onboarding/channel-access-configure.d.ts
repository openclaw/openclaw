import type { OpenClawConfig } from "../../../config/config.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { type ChannelAccessPolicy } from "./channel-access.js";
export declare function configureChannelAccessWithAllowlist<TResolved>(params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    label: string;
    currentPolicy: ChannelAccessPolicy;
    currentEntries: string[];
    placeholder: string;
    updatePrompt: boolean;
    setPolicy: (cfg: OpenClawConfig, policy: ChannelAccessPolicy) => OpenClawConfig;
    resolveAllowlist: (params: {
        cfg: OpenClawConfig;
        entries: string[];
    }) => Promise<TResolved>;
    applyAllowlist: (params: {
        cfg: OpenClawConfig;
        resolved: TResolved;
    }) => OpenClawConfig;
}): Promise<OpenClawConfig>;
