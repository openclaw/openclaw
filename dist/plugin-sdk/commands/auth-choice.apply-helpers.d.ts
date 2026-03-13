import type { OpenClawConfig } from "../config/types.js";
import { type SecretInput, type SecretRef } from "../config/types.secrets.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import type { SecretInputMode } from "./onboard-types.js";
export type SecretInputModePromptCopy = {
    modeMessage?: string;
    plaintextLabel?: string;
    plaintextHint?: string;
    refLabel?: string;
    refHint?: string;
};
export type SecretRefOnboardingPromptCopy = {
    sourceMessage?: string;
    envVarMessage?: string;
    envVarPlaceholder?: string;
    envVarFormatError?: string;
    envVarMissingError?: (envVar: string) => string;
    noProvidersMessage?: string;
    envValidatedMessage?: (envVar: string) => string;
    providerValidatedMessage?: (provider: string, id: string, source: "file" | "exec") => string;
};
export declare function promptSecretRefForOnboarding(params: {
    provider: string;
    config: OpenClawConfig;
    prompter: WizardPrompter;
    preferredEnvVar?: string;
    copy?: SecretRefOnboardingPromptCopy;
}): Promise<{
    ref: SecretRef;
    resolvedValue: string;
}>;
export declare function createAuthChoiceAgentModelNoter(params: ApplyAuthChoiceParams): (model: string) => Promise<void>;
export interface ApplyAuthChoiceModelState {
    config: ApplyAuthChoiceParams["config"];
    agentModelOverride: string | undefined;
}
export declare function createAuthChoiceModelStateBridge(bindings: {
    getConfig: () => ApplyAuthChoiceParams["config"];
    setConfig: (config: ApplyAuthChoiceParams["config"]) => void;
    getAgentModelOverride: () => string | undefined;
    setAgentModelOverride: (model: string | undefined) => void;
}): ApplyAuthChoiceModelState;
export declare function createAuthChoiceDefaultModelApplier(params: ApplyAuthChoiceParams, state: ApplyAuthChoiceModelState): (options: Omit<Parameters<typeof applyDefaultModelChoice>[0], "config" | "setDefaultModel" | "noteAgentModel" | "prompter">) => Promise<void>;
export declare function createAuthChoiceDefaultModelApplierForMutableState(params: ApplyAuthChoiceParams, getConfig: () => ApplyAuthChoiceParams["config"], setConfig: (config: ApplyAuthChoiceParams["config"]) => void, getAgentModelOverride: () => string | undefined, setAgentModelOverride: (model: string | undefined) => void): ReturnType<typeof createAuthChoiceDefaultModelApplier>;
export declare function normalizeTokenProviderInput(tokenProvider: string | null | undefined): string | undefined;
export declare function normalizeSecretInputModeInput(secretInputMode: string | null | undefined): SecretInputMode | undefined;
export declare function resolveSecretInputModeForEnvSelection(params: {
    prompter: WizardPrompter;
    explicitMode?: SecretInputMode;
    copy?: SecretInputModePromptCopy;
}): Promise<SecretInputMode>;
export declare function maybeApplyApiKeyFromOption(params: {
    token: string | undefined;
    tokenProvider: string | undefined;
    secretInputMode?: SecretInputMode;
    expectedProviders: string[];
    normalize: (value: string) => string;
    setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
}): Promise<string | undefined>;
export declare function ensureApiKeyFromOptionEnvOrPrompt(params: {
    token: string | undefined;
    tokenProvider: string | undefined;
    secretInputMode?: SecretInputMode;
    config: OpenClawConfig;
    expectedProviders: string[];
    provider: string;
    envLabel: string;
    promptMessage: string;
    normalize: (value: string) => string;
    validate: (value: string) => string | undefined;
    prompter: WizardPrompter;
    setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
    noteMessage?: string;
    noteTitle?: string;
}): Promise<string>;
export declare function ensureApiKeyFromEnvOrPrompt(params: {
    config: OpenClawConfig;
    provider: string;
    envLabel: string;
    promptMessage: string;
    normalize: (value: string) => string;
    validate: (value: string) => string | undefined;
    prompter: WizardPrompter;
    secretInputMode?: SecretInputMode;
    setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
}): Promise<string>;
