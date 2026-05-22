import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { ProviderAuthMethod, ProviderPlugin, ProviderPluginWizardSetup } from "./types.js";
export type ProviderWizardOption = {
    value: string;
    label: string;
    hint?: string;
    groupId: string;
    groupLabel: string;
    groupHint?: string;
    onboardingScopes?: Array<"text-inference" | "image-generation">;
    assistantPriority?: number;
    assistantVisibility?: "visible" | "manual-only";
};
export type ProviderModelPickerEntry = {
    value: string;
    label: string;
    hint?: string;
};
type ProviderWizardProvidersResolver = (params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}) => ProviderPlugin[];
export declare function setProviderWizardProvidersResolverForTest(resolver: ProviderWizardProvidersResolver | undefined): () => void;
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
    wizard?: ProviderPluginWizardSetup;
} | null;
export declare function runProviderModelSelectedHook(params: {
    config: OpenClawConfig;
    model: string;
    prompter: WizardPrompter;
    agentDir?: string;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<void>;
export {};
