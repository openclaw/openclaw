import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ProviderAuthChoiceMetadata = {
    pluginId: string;
    providerId: string;
    methodId: string;
    choiceId: string;
    choiceLabel: string;
    choiceHint?: string;
    assistantPriority?: number;
    assistantVisibility?: "visible" | "manual-only";
    deprecatedChoiceIds?: string[];
    groupId?: string;
    groupLabel?: string;
    groupHint?: string;
    optionKey?: string;
    cliFlag?: string;
    cliOption?: string;
    cliDescription?: string;
    onboardingScopes?: ("text-inference" | "image-generation")[];
};
export type ProviderOnboardAuthFlag = {
    optionKey: string;
    authChoice: string;
    cliFlag: string;
    cliOption: string;
    description: string;
};
type ManifestProviderAuthChoiceParams = {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    includeUntrustedWorkspacePlugins?: boolean;
};
export declare function resolveManifestProviderAuthChoices(params?: ManifestProviderAuthChoiceParams): ProviderAuthChoiceMetadata[];
export declare function resolveManifestProviderAuthChoice(choiceId: string, params?: ManifestProviderAuthChoiceParams): ProviderAuthChoiceMetadata | undefined;
export declare function resolveManifestProviderApiKeyChoice(params: {
    providerId: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    includeUntrustedWorkspacePlugins?: boolean;
}): ProviderAuthChoiceMetadata | undefined;
export declare function resolveManifestDeprecatedProviderAuthChoice(choiceId: string, params?: ManifestProviderAuthChoiceParams): ProviderAuthChoiceMetadata | undefined;
export declare function resolveManifestProviderOnboardAuthFlags(params?: ManifestProviderAuthChoiceParams): ProviderOnboardAuthFlag[];
export {};
