import type { ProviderAuthMethod } from "../plugins/types.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
export type PluginProviderAuthChoiceOptions = {
    authChoice: string;
    pluginId: string;
    providerId: string;
    methodId?: string;
    label: string;
};
export declare function runProviderPluginAuthMethod(params: {
    config: ApplyAuthChoiceParams["config"];
    runtime: ApplyAuthChoiceParams["runtime"];
    prompter: ApplyAuthChoiceParams["prompter"];
    method: ProviderAuthMethod;
    agentDir?: string;
    agentId?: string;
    workspaceDir?: string;
    emitNotes?: boolean;
}): Promise<{
    config: ApplyAuthChoiceParams["config"];
    defaultModel?: string;
}>;
export declare function applyAuthChoiceLoadedPluginProvider(params: ApplyAuthChoiceParams): Promise<ApplyAuthChoiceResult | null>;
export declare function applyAuthChoicePluginProvider(params: ApplyAuthChoiceParams, options: PluginProviderAuthChoiceOptions): Promise<ApplyAuthChoiceResult | null>;
