import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { ProviderAuthMethod, ProviderPlugin } from "./types.js";
export declare const PROVIDER_PLUGIN_CHOICE_PREFIX = "provider-plugin:";
export type ProviderWizardOption = {
    value: string;
    label: string;
    hint?: string;
    groupId: string;
    groupLabel: string;
    groupHint?: string;
};
export type ProviderModelPickerEntry = {
    value: string;
    label: string;
    hint?: string;
};
export declare function buildProviderPluginMethodChoice(providerId: string, methodId: string): string;
export declare function resolveProviderWizardOptions(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ProviderWizardOption[];
export declare function resolveProviderModelPickerEntries(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ProviderModelPickerEntry[];
export declare function resolveProviderPluginChoice(params: {
    providers: ProviderPlugin[];
    choice: string;
}): {
    provider: ProviderPlugin;
    method: ProviderAuthMethod;
} | null;
export declare function runProviderModelSelectedHook(params: {
    config: OpenClawConfig;
    model: string;
    prompter: WizardPrompter;
    agentDir?: string;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<void>;
