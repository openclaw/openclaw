import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { ProviderAuthMethod, ProviderAuthOptionBag } from "./types.js";
export type ApplyProviderAuthChoiceParams = {
    authChoice: string;
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    prompter: WizardPrompter;
    runtime: RuntimeEnv;
    agentDir?: string;
    setDefaultModel: boolean;
    preserveExistingDefaultModel?: boolean;
    agentId?: string;
    opts?: Partial<ProviderAuthOptionBag>;
};
export type ApplyProviderAuthChoiceResult = {
    config: OpenClawConfig;
    agentModelOverride?: string;
    retrySelection?: boolean;
};
export type PluginProviderAuthChoiceOptions = {
    authChoice: string;
    pluginId: string;
    providerId: string;
    methodId?: string;
    label: string;
};
type ProviderAuthChoiceRuntime = typeof import("./provider-auth-choice.runtime.js");
declare const defaultProviderAuthChoiceDeps: {
    loadPluginProviderRuntime: () => Promise<ProviderAuthChoiceRuntime>;
};
export declare const __testing: {
    resetDepsForTest(): void;
    setDepsForTest(deps: Partial<typeof defaultProviderAuthChoiceDeps>): void;
};
export declare function runProviderPluginAuthMethod(params: {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    runtime: RuntimeEnv;
    prompter: WizardPrompter;
    method: ProviderAuthMethod;
    agentDir?: string;
    agentId?: string;
    workspaceDir?: string;
    emitNotes?: boolean;
    secretInputMode?: ProviderAuthOptionBag["secretInputMode"];
    allowSecretRefPrompt?: boolean;
    opts?: Partial<ProviderAuthOptionBag>;
}): Promise<{
    config: OpenClawConfig;
    defaultModel?: string;
}>;
export declare function applyAuthChoiceLoadedPluginProvider(params: ApplyProviderAuthChoiceParams): Promise<ApplyProviderAuthChoiceResult | null>;
export declare function applyAuthChoicePluginProvider(params: ApplyProviderAuthChoiceParams, options: PluginProviderAuthChoiceOptions): Promise<ApplyProviderAuthChoiceResult | null>;
export {};
